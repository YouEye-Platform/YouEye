package ordering

import (
	"fmt"
	"strconv"
	"strings"
)

type Version struct {
	Core []uint64
	Pre  []Identifier
}

type Identifier struct {
	Value   string
	Numeric bool
	Number  uint64
}

func ParseVersion(value string) (Version, error) {
	if value == "" || strings.TrimSpace(value) != value {
		return Version{}, fmt.Errorf("version must be nonempty and unpadded")
	}
	withoutBuild, build, hasBuild := strings.Cut(value, "+")
	if hasBuild {
		if strings.Contains(build, "+") || !validIdentifiers(build, false) {
			return Version{}, fmt.Errorf("version build metadata is malformed")
		}
	}
	core, prerelease, hasPrerelease := strings.Cut(withoutBuild, "-")
	parts := strings.Split(core, ".")
	if len(parts) < 3 || len(parts) > 10 {
		return Version{}, fmt.Errorf("version core must contain 3 to 10 numeric components")
	}
	numbers := make([]uint64, len(parts))
	for i, part := range parts {
		number, err := parseNumericIdentifier(part)
		if err != nil {
			return Version{}, fmt.Errorf("version core component %q: %w", part, err)
		}
		numbers[i] = number
	}
	version := Version{Core: numbers}
	if hasPrerelease {
		if !validIdentifiers(prerelease, true) {
			return Version{}, fmt.Errorf("version prerelease is malformed")
		}
		for _, value := range strings.Split(prerelease, ".") {
			identifier := Identifier{Value: value}
			if isDigits(value) {
				number, err := parseNumericIdentifier(value)
				if err != nil {
					return Version{}, fmt.Errorf("version prerelease component %q: %w", value, err)
				}
				identifier.Numeric = true
				identifier.Number = number
			}
			version.Pre = append(version.Pre, identifier)
		}
	}
	return version, nil
}

func ValidateIdentity(version string) error {
	if _, err := ParseVersion(version); err != nil {
		return fmt.Errorf("invalid image version %q: %w", version, err)
	}
	return nil
}

func CompareVersion(left, right Version) int {
	coreLength := max(len(left.Core), len(right.Core))
	for i := 0; i < coreLength; i++ {
		var leftPart, rightPart uint64
		if i < len(left.Core) {
			leftPart = left.Core[i]
		}
		if i < len(right.Core) {
			rightPart = right.Core[i]
		}
		if leftPart < rightPart {
			return -1
		}
		if leftPart > rightPart {
			return 1
		}
	}
	if len(left.Pre) == 0 && len(right.Pre) == 0 {
		return 0
	}
	if len(left.Pre) == 0 {
		return 1
	}
	if len(right.Pre) == 0 {
		return -1
	}
	for i := 0; i < len(left.Pre) && i < len(right.Pre); i++ {
		l, r := left.Pre[i], right.Pre[i]
		if l.Numeric && r.Numeric {
			if l.Number < r.Number {
				return -1
			}
			if l.Number > r.Number {
				return 1
			}
			continue
		}
		if l.Numeric != r.Numeric {
			if l.Numeric {
				return -1
			}
			return 1
		}
		if l.Value < r.Value {
			return -1
		}
		if l.Value > r.Value {
			return 1
		}
	}
	if len(left.Pre) < len(right.Pre) {
		return -1
	}
	if len(left.Pre) > len(right.Pre) {
		return 1
	}
	return 0
}

func RequireUpgradeIdentity(currentVersion, incomingVersion string) error {
	current, err := ParseVersion(currentVersion)
	if err != nil {
		return fmt.Errorf("current image version %q: %w", currentVersion, err)
	}
	incoming, err := ParseVersion(incomingVersion)
	if err != nil {
		return fmt.Errorf("incoming image version %q: %w", incomingVersion, err)
	}
	if CompareVersion(incoming, current) <= 0 {
		return fmt.Errorf("incoming image version %s is not newer than installed version %s", incomingVersion, currentVersion)
	}
	return nil
}

func parseNumericIdentifier(value string) (uint64, error) {
	if !isDigits(value) {
		return 0, fmt.Errorf("must be numeric")
	}
	if len(value) > 1 && value[0] == '0' {
		return 0, fmt.Errorf("must not contain leading zeroes")
	}
	number, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("numeric value is out of range")
	}
	return number, nil
}

func validIdentifiers(value string, prerelease bool) bool {
	if value == "" {
		return false
	}
	for _, identifier := range strings.Split(value, ".") {
		if identifier == "" {
			return false
		}
		for _, r := range identifier {
			if !((r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || r == '-') {
				return false
			}
		}
		if prerelease && isDigits(identifier) && len(identifier) > 1 && identifier[0] == '0' {
			return false
		}
	}
	return true
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
