package cmd

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var userCmd = &cobra.Command{
	Use:   "user",
	Short: "Manage users",
}

var userListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all users",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		users, err := cp.GetArray("/api/people")
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

var userCreateEmail string

var userCreateCmd = &cobra.Command{
	Use:   "create <username>",
	Short: "Create a new user",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		username := args[0]

		if userCreateEmail == "" {
			fmt.Print("Email: ")
			scanner := bufio.NewScanner(os.Stdin)
			if scanner.Scan() {
				userCreateEmail = strings.TrimSpace(scanner.Text())
			}
		}

		password := readPassword("Password: ")

		result, err := cp.Post("/api/people", map[string]interface{}{
			"username": username,
			"email":    userCreateEmail,
			"password": password,
		})
		if err != nil {
			return err
		}
		output.Success("User created: " + str(result, "username"))
		return nil
	},
}

var userDeleteCmd = &cobra.Command{
	Use:   "delete <username>",
	Short: "Delete a user",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		users, err := cp.GetArray("/api/people")
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

		_, err = cp.Delete("/api/people/" + userID)
		if err != nil {
			return err
		}
		output.Success("User deleted: " + args[0])
		return nil
	},
}

var userPasswordCmd = &cobra.Command{
	Use:   "password <username>",
	Short: "Set or reset a user's password",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		users, err := cp.GetArray("/api/people")
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

		_, err = cp.Post("/api/people/"+userID+"/password", map[string]interface{}{
			"password": password,
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
		if !requireCP() {
			return nil
		}
		users, err := cp.GetArray("/api/people")
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
	userCreateCmd.Flags().StringVar(&userCreateEmail, "email", "", "User email address")

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
