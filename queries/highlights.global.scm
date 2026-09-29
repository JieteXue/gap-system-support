; Last matching query wins, so list rules from least to most specific.
(identifier) @variable

; Constants
; convention: constants are of the form ALL_CAPS_AND_UNDERSCORES and have length at least 2
((identifier) @constant
  (#match? @constant "^[A-Z_][A-Z_]+$"))

; Functions
(assignment_statement
  left: (identifier) @function
  right: (function))

(assignment_statement
  left: (identifier) @function
  right: (atomic_function))

(assignment_statement
  left: (identifier) @function
  right: (lambda))

(parameters
  (identifier) @variable.parameter)

(qualified_parameters
  (identifier) @variable.parameter)

(qualified_parameters
  (qualified_identifier
    (identifier) @variable.parameter))

(lambda_parameters
  (identifier) @variable.parameter)

; arg is treated specially when it is the only parameter of a function
((parameters
  .
  (identifier) @variable.parameter.builtin .)
  (#eq? @variable.parameter.builtin "arg"))

((qualified_parameters
  .
  (identifier) @variable.parameter.builtin .)
  (#eq? @variable.parameter.builtin "arg"))

((qualified_parameters
  .
  (qualified_identifier
    (identifier) @variable.parameter.builtin) .)
  (#eq? @variable.parameter.builtin "arg"))

((lambda_parameters
  .
  (identifier) @variable.parameter.builtin .)
  (#eq? @variable.parameter.builtin "arg"))

(locals
  (identifier) @variable.parameter)

; Literals
(bool) @constant.builtin

(tilde) @variable.builtin

; Record selectors
(record_entry
  left: [
    (identifier)
    (integer)
  ] @variable.member)

(record_selector
  selector: [
    (identifier)
    (integer)
  ] @variable.member)

(component_selector
  selector: [
    (identifier)
    (integer)
  ] @variable.member)

; Function-valued record fields override the generic member highlighting.
(record_entry
  left: (identifier) @function
  right: [
    (function)
    (atomic_function)
    (lambda)
  ])

(assignment_statement
  left: [
    (record_selector
      selector: (identifier) @function)
    (component_selector
      selector: (identifier) @function)
  ]
  right: [
    (function)
    (atomic_function)
    (lambda)
  ])

((call
  function: (identifier) @function.builtin)
  (#any-of? @function.builtin "Assert" "Info" "IsBound" "Unbind" "TryNextMethod"))

(function_call_option
  [
    (identifier)
    (record_entry ;Record entries specify global properties in function calls
      left: [
        (identifier)
        (integer)
      ])
  ] @property)

(help_statement
  (help_selector) @property)
