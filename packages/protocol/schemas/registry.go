// Package schemas embeds the contracts Go reads at run time, so the JSON
// beside this file stays the one copy.
package schemas

import _ "embed"

// GraderRegistry is grader-registry.json: every eval grader type, its kind
// and its options schema.
//
//go:embed grader-registry.json
var GraderRegistry []byte
