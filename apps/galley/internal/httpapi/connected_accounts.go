package httpapi

import (
	"fmt"
	"regexp"
)

const (
	scopeFieldMaxLength = 200

	unsupportedScopeCode = "unsupported_scope"

	// A substitute for a real Connected Account (M8, #9). Every Owner has it; it authorizes nothing by itself.
	controlledAccount = "controlled"
)

type permissionScope struct {
	account, action, resource string
}

func (s permissionScope) String() string {
	return fmt.Sprintf("%s %s %s", s.account, s.action, s.resource)
}

const scopeName = `[a-z0-9][a-z0-9-]{0,63}`

var connectedAccountActions = map[string]map[string]*regexp.Regexp{
	controlledAccount: {
		"read_note":    regexp.MustCompile(`^notes/` + scopeName + `$`),
		"write_note":   regexp.MustCompile(`^notes/` + scopeName + `$`),
		"post_message": regexp.MustCompile(`^channels/` + scopeName + `$`),
	},
}

func isSubstituteAccount(account string) bool {
	return account == controlledAccount
}

func unsupportedScope(scope permissionScope) string {
	actions, ok := connectedAccountActions[scope.account]
	if !ok {
		return fmt.Sprintf("%q is not a Connected Account Galley knows", scope.account)
	}
	pattern, ok := actions[scope.action]
	if !ok {
		return fmt.Sprintf("the %q Connected Account declares no action %q", scope.account, scope.action)
	}
	if !pattern.MatchString(scope.resource) {
		return fmt.Sprintf("%q does not fit the resource pattern the %q Connected Account declares for %q", scope.resource, scope.account, scope.action)
	}
	return ""
}

func validateScopeFields(scope permissionScope) string {
	for _, field := range []struct{ name, value string }{{"account", scope.account}, {"action", scope.action}, {"resource", scope.resource}} {
		if !validEventText(field.value, scopeFieldMaxLength) {
			return fmt.Sprintf(`%q must be 1 to %d characters without control characters`, field.name, scopeFieldMaxLength)
		}
	}
	return ""
}
