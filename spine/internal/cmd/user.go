package cmd

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

var userCmd = &cobra.Command{
	Use:   "user",
	Short: "Manage users",
}

var userListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all users",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		users, err := controlClient.GetArray("/api/people")
		if err != nil {
			return err
		}

		rows := [][]string{}
		for _, u := range users {
			user, ok := u.(map[string]interface{})
			if !ok {
				continue
			}
			name := firstOf(user, "username", "name")
			email := firstOf(user, "email")
			admin := firstOf(user, "isAdmin", "is_superuser")
			active := firstOf(user, "isActive", "is_active")
			rows = append(rows, []string{name, email, admin, active})
		}
		output.Table([]string{"USERNAME", "EMAIL", "ADMIN", "ACTIVE"}, rows)
		return nil
	},
}

var (
	userCreateEmail         string
	userCreateFirstName     string
	userCreateLastName      string
	userCreatePasswordStdin bool
)

var userCreateCmd = &cobra.Command{
	Use:   "create <username>",
	Short: "Create a new user",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		username := args[0]

		// With --password-stdin, stdin is the password: a prompt would read it as its answer (a missing
		// --last-name took the password as the last name, and creation failed with "password could not be read").
		if err := userCreateStdinCheck(userCreatePasswordStdin, userCreateFirstName, userCreateEmail); err != nil {
			return err
		}

		if userCreateFirstName == "" {
			fmt.Print("First name: ")
			scanner := bufio.NewScanner(os.Stdin)
			if scanner.Scan() {
				userCreateFirstName = strings.TrimSpace(scanner.Text())
			}
		}
		if userCreateFirstName == "" {
			return fmt.Errorf("first name is required")
		}

		if !cmd.Flags().Changed("last-name") && !userCreatePasswordStdin {
			fmt.Print("Last name (optional): ")
			scanner := bufio.NewScanner(os.Stdin)
			if scanner.Scan() {
				userCreateLastName = strings.TrimSpace(scanner.Text())
			}
		}

		if userCreateEmail == "" {
			fmt.Print("Email: ")
			scanner := bufio.NewScanner(os.Stdin)
			if scanner.Scan() {
				userCreateEmail = strings.TrimSpace(scanner.Text())
			}
		}

		var password, repeatPassword string
		if userCreatePasswordStdin {
			scanner := bufio.NewScanner(os.Stdin)
			if !scanner.Scan() {
				return fmt.Errorf("password could not be read from stdin")
			}
			password = scanner.Text()
			repeatPassword = password
		} else {
			password = readPassword("Password: ")
			repeatPassword = readPassword("Repeat password: ")
		}
		if password != repeatPassword {
			return fmt.Errorf("passwords do not match")
		}

		result, err := controlClient.Post("/api/people", map[string]interface{}{
			"username":       username,
			"firstName":      userCreateFirstName,
			"lastName":       userCreateLastName,
			"email":          userCreateEmail,
			"password":       password,
			"repeatPassword": repeatPassword,
		})
		if err != nil {
			return err
		}
		output.Success("User created: " + createdUsername(result, username))
		return nil
	},
}

// createdUsername reads the name from the Control Panel's answer ({"user": {"username": …}}); the line used to
// read a top-level "username" that is not there and printed "User created: " with nothing after it.
func createdUsername(result map[string]interface{}, asked string) string {
	if user, ok := result["user"].(map[string]interface{}); ok {
		if name := str(user, "username"); name != "" {
			return name
		}
	}
	return asked
}

// userCreateStdinCheck: with --password-stdin nothing may be asked on stdin, so what a prompt would ask for must
// come as flags (the optional last name is then simply not asked for).
func userCreateStdinCheck(passwordStdin bool, firstName, email string) error {
	if passwordStdin && (firstName == "" || email == "") {
		return fmt.Errorf("with --password-stdin, give --first-name and --email as flags (stdin is the password)")
	}
	return nil
}

var userDeleteRetainData bool

var userDeleteCmd = &cobra.Command{
	Use:   "delete <username>",
	Short: "Delete a user",
	Long: `Delete a user.

A user whose data apps keep (an app with a folder or account per user) is refused until that data is decided on.
--retain-data retains it first, in every app: it stays on the box, held for no one, and the apps go on for everyone
else (the "retain" choice of an app's Access settings). There is no way to dispose of retained data: such an app
can afterwards be removed only keeping its data. A user who administers an app or installed one (its app-wide
data is theirs) is still refused: transfer the app's administration in its Access settings, and remove such an app
(youeye app remove <app>) or retain its data there, which closes the app, first.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		users, err := controlClient.GetArray("/api/people")
		if err != nil {
			return err
		}

		var userID string
		for _, u := range users {
			user, ok := u.(map[string]interface{})
			if !ok {
				continue
			}
			if firstOf(user, "username") == args[0] {
				userID = firstOf(user, "pk", "id")
				break
			}
		}
		if userID == "" {
			return fmt.Errorf("user '%s' not found", args[0])
		}

		path := "/api/people/" + userID
		if userDeleteRetainData {
			path += "?retainData=true"
		}
		result, err := controlClient.Delete(path)
		if err != nil {
			return userDeleteError(err, userDeleteRetainData)
		}
		if apps, ok := result["retainedDataApps"].([]interface{}); ok && len(apps) > 0 {
			names := make([]string, 0, len(apps))
			for _, app := range apps {
				names = append(names, fmt.Sprint(app))
			}
			output.Info("Retained their data in: " + strings.Join(names, ", "))
		}
		output.Success("User deleted: " + args[0])
		return nil
	},
}

// userDeleteError: a refusal (409) says why in the Control Panel's own words, and how to go on when --retain-data can.
func userDeleteError(err error, retainData bool) error {
	var httpErr *controlapi.HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != 409 || httpErr.Field("error") == "" {
		return err
	}
	message := httpErr.Field("error")
	if !retainData && httpErr.Field("code") == "disposition_required" && !strings.HasPrefix(message, "Appliance owner") {
		message += ". To retain the data apps keep for this user and delete them: youeye user delete <user> --retain-data"
	}
	return errors.New(message)
}

var userPasswordCmd = &cobra.Command{
	Use:   "password <username>",
	Short: "Set or reset a user's password",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		users, err := controlClient.GetArray("/api/people")
		if err != nil {
			return err
		}

		var userID string
		for _, u := range users {
			user, ok := u.(map[string]interface{})
			if !ok {
				continue
			}
			if firstOf(user, "username") == args[0] {
				userID = firstOf(user, "pk", "id")
				break
			}
		}
		if userID == "" {
			return fmt.Errorf("user '%s' not found", args[0])
		}

		password := readPassword("New password: ")

		_, err = controlClient.Post("/api/people/"+userID+"/password", map[string]interface{}{
			"password":       password,
			"repeatPassword": password,
		})
		if err != nil {
			return err
		}
		output.Success("Password updated for " + args[0])
		return nil
	},
}

var userInfoCmd = &cobra.Command{
	Use:   "info <username>",
	Short: "Show user details",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		users, err := controlClient.GetArray("/api/people")
		if err != nil {
			return err
		}

		for _, u := range users {
			user, ok := u.(map[string]interface{})
			if !ok {
				continue
			}
			if firstOf(user, "username") == args[0] {
				output.Section("User: " + args[0])
				output.StatusLine("Username", firstOf(user, "username"), "")
				output.StatusLine("Email", firstOf(user, "email"), "")
				output.StatusLine("Name", firstOf(user, "name"), "")
				output.StatusLine("Admin", firstOf(user, "isAdmin", "is_superuser"), "")
				output.StatusLine("Active", firstOf(user, "isActive", "is_active"), "")
				return nil
			}
		}
		return fmt.Errorf("user '%s' not found", args[0])
	},
}

func init() {
	userCreateCmd.Flags().StringVar(&userCreateFirstName, "first-name", "", "User first name")
	userCreateCmd.Flags().StringVar(&userCreateLastName, "last-name", "", "User last name (optional)")
	userCreateCmd.Flags().StringVar(&userCreateEmail, "email", "", "User email address")
	userCreateCmd.Flags().BoolVar(&userCreatePasswordStdin, "password-stdin", false, "Read one password from stdin without echoing it in arguments")

	userDeleteCmd.Flags().BoolVar(&userDeleteRetainData, "retain-data", false, "Retain (quarantine) the data apps keep for this user, then delete them")

	userCmd.AddCommand(userListCmd)
	userCmd.AddCommand(userCreateCmd)
	userCmd.AddCommand(userDeleteCmd)
	userCmd.AddCommand(userPasswordCmd)
	userCmd.AddCommand(userInfoCmd)
}

// readPassword prompts for a password with echo disabled via stty.
func readPassword(prompt string) string {
	fmt.Print(prompt)
	exec.Command("stty", "-echo", "-F", "/dev/stdin").Run()
	scanner := bufio.NewScanner(os.Stdin)
	var pw string
	if scanner.Scan() {
		pw = scanner.Text()
	}
	exec.Command("stty", "echo", "-F", "/dev/stdin").Run()
	fmt.Println()
	return pw
}
