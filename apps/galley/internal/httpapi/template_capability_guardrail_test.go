package httpapi

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// templateAwareIdentifiers is every identifier this module introduces
// for a Ticket's Template and its completion condition (issue #59):
// the two enum types and their four values, generated into api.gen.go
// from contracts/openapi.yaml's TicketTemplate/TicketCompletionCondition
// schemas.
var templateAwareIdentifiers = map[string]bool{
	"TicketTemplate":            true,
	"Basic":                     true,
	"Coding":                    true,
	"TicketCompletionCondition": true,
	"HumanAcceptance":           true,
	"ReviewedPrMerge":           true,
}

// templateAwareLiterals is the same six values as they appear on the
// wire and in the database, because `template` is a TEXT column and
// TicketTemplate is a string-backed type: `t.Template == "Coding"`
// compiles and behaves identically to `t.Template == Coding` while
// being a *ast.BasicLit rather than an *ast.Ident. Scanning only
// identifiers let that form through -- found in review of this slice.
var templateAwareLiterals = map[string]bool{
	"Basic":           true,
	"Coding":          true,
	"humanAcceptance": true,
	"reviewedPrMerge": true,
}

// allowedTemplateAwareFunctions is the complete, closed list of
// functions in this Go module allowed to reference any identifier in
// templateAwareIdentifiers. D3 (docs/decisions/d3-agent-template-compatibility.md)
// requires that a Ticket's Template supply presentation, required
// information, and a *default* completion condition ONLY -- it must
// never restrict which Agent or execution engine may be assigned. M2
// has no Agent, Assignee, Round, or engine concept at all (AGENTS.md,
// "No AI, Agents, Rounds, or Michelin in M2"), so the complete set of
// legitimate Template-aware code today is exactly: the two HTTP
// handlers that accept/validate/reject it (CreateTicket, UpdateTicket),
// the query helpers that write and read the columns (insertTicket,
// scanTicketRow, updateTicketForOwner -- present so this test also
// covers its SQL never being handed a template/completion_condition
// parameter), and the one function that derives the Template's
// *default* completion condition, exactly once, at creation
// (defaultCompletionCondition).
//
// This list is the guardrail, not its length: a future change that
// makes an Agent, Assignee, or execution engine depend on a Ticket's
// Template -- anywhere in this module, in a new function or a new
// package-level variable -- adds a reference this test does not
// already know about and fails until a person deliberately extends
// this map, which is the point at which "why does this new code care
// about Template?" gets asked. See "Proof this test has teeth" in
// docs/evidence/m2/59-*.md for a captured run demonstrating exactly
// this failure mode with a deliberately added mapping function,
// reverted afterward.
var allowedTemplateAwareFunctions = map[string]bool{
	"CreateTicket":               true,
	"UpdateTicket":               true,
	"insertTicket":               true,
	"scanTicketRow":              true,
	"updateTicketForOwner":       true,
	"defaultCompletionCondition": true,
	// Issue #60 (D3 S2, "Completing human work that requires a
	// reviewed PR merge"): Accept reads a Ticket's own already-retained
	// completionCondition to decide whether it can complete at all, and
	// rejects reviewedPrMerge with an explicit current-implementation
	// reason (D2/M8) rather than silently downgrading it. This reads
	// the condition to gate a human Owner action (Accept); it does not
	// map a Template to an Agent, engine, or capability -- the one
	// thing D3 forbids -- so it belongs on this allowlist deliberately,
	// not as a workaround.
	"AcceptTicket":          true,
	"decideAccept":          true,
	"applyTicketTransition": true,
	// ChangeTicketStatus's decide closure also names
	// TicketCompletionCondition as a parameter type (unused by its own
	// logic, which only ever branches on Status) purely to satisfy
	// applyTicketTransition's shared decide signature -- see
	// docs/evidence/m2/60-lifecycle-transitions.md.
	"ChangeTicketStatus": true,
}

// excludedTemplateGuardrailFiles are files this scan does not inspect:
// generated code (api.gen.go declares the enum types and their Valid()
// methods themselves -- pure schema binding, not application logic
// that could express a capability mapping) and this guardrail test
// file's own fixture data (its violation-reporting logic legitimately
// mentions these identifiers as strings and map keys, not as Go
// identifiers referencing the real types/consts).
var excludedTemplateGuardrailFiles = map[string]bool{
	"api.gen.go": true,
}

// TestNoTemplateToCapabilityMapping is issue #59's guardrail for "no
// Template-to-Agent or Template-to-engine mapping exists anywhere in
// the code." Proving a negative over an entire codebase by assertion
// alone is unfalsifiable, so instead this parses every non-generated,
// non-test .go file in this module with go/parser and finds every
// syntactic reference to a Template-related identifier
// (templateAwareIdentifiers), attributes each one to its enclosing
// top-level function (or to file/package scope, for a reference
// outside any function -- e.g. a package-level variable), and fails if
// that attribution set is not exactly allowedTemplateAwareFunctions.
//
// This is a real, falsifiable check, not a tautology: it would fail
// the moment any code anywhere in this module -- today or added by a
// future slice -- introduces a new function, method, or package-level
// declaration that inspects a Ticket's Template to decide anything
// about an Agent, Assignee, or execution engine, because that new code
// is necessarily a new attribution this map does not already contain.
// It would NOT catch a mapping hidden entirely inside one of the
// already-whitelisted functions (e.g. smuggled into
// defaultCompletionCondition itself) -- that residual gap is exactly
// why the whitelist is kept as small as the real, legitimate set of
// Template-aware code, so any addition to it is a deliberate,
// reviewable diff to this file.
func TestNoTemplateToCapabilityMapping(t *testing.T) {
	moduleRoot := galleyModuleRoot(t)

	violations := map[string]bool{}
	fset := token.NewFileSet()

	err := filepath.Walk(moduleRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		if excludedTemplateGuardrailFiles[filepath.Base(path)] {
			return nil
		}

		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return fmt.Errorf("failed to parse %s: %w", path, err)
		}

		rel, err := filepath.Rel(moduleRoot, path)
		if err != nil {
			rel = path
		}

		for _, decl := range file.Decls {
			funcDecl, isFunc := decl.(*ast.FuncDecl)
			label := fmt.Sprintf("%s: package scope", rel)
			allowed := false
			if isFunc {
				label = fmt.Sprintf("%s: func %s", rel, funcDecl.Name.Name)
				allowed = allowedTemplateAwareFunctions[funcDecl.Name.Name]
			}

			found := false
			ast.Inspect(decl, func(n ast.Node) bool {
				switch node := n.(type) {
				case *ast.Ident:
					if templateAwareIdentifiers[node.Name] {
						found = true
					}
				case *ast.BasicLit:
					if node.Kind == token.STRING {
						if unquoted, err := strconv.Unquote(node.Value); err == nil && templateAwareLiterals[unquoted] {
							found = true
						}
					}
				}
				return true
			})

			if found && !allowed {
				violations[label] = true
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("failed to scan %s for Template-aware code: %v", moduleRoot, err)
	}

	if len(violations) > 0 {
		list := make([]string, 0, len(violations))
		for v := range violations {
			list = append(list, v)
		}
		sort.Strings(list)
		t.Fatalf(
			"found code outside the reviewed allowlist referencing a Template/completion-condition identifier "+
				"(TicketTemplate, Basic, Coding, TicketCompletionCondition, HumanAcceptance, ReviewedPrMerge):\n  %s\n"+
				"D3 permits a Template to supply presentation, required information, and a default completion "+
				"condition ONLY -- never an Agent/engine restriction. If this new code is legitimate (e.g. this "+
				"slice's own new plumbing), add its function name to allowedTemplateAwareFunctions in "+
				"template_capability_guardrail_test.go deliberately. If it maps a Template to an allowed Agent, "+
				"engine, or capability, that violates D3 and must be removed instead.",
			strings.Join(list, "\n  "),
		)
	}
}

// galleyModuleRoot locates apps/galley from this test file's own
// package directory (apps/galley/internal/httpapi), the same
// two-levels-up technique cmd/galley/restart_durability_test.go's
// buildGalleyBinary already uses to find the module root regardless of
// the working directory `go test` runs each package from.
func galleyModuleRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to determine working directory: %v", err)
	}
	root := filepath.Clean(filepath.Join(wd, "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("expected %s to be apps/galley (go.mod not found): %v", root, err)
	}
	return root
}
