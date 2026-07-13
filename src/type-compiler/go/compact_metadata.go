package main

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

const (
	compactMetadataRuntimeSpec       = "@zyno-io/ts-server-foundation/type-metadata-runtime"
	compactMetadataDecoderName       = "decodeCompactMetadataV1"
	compactMetadataRegistryName      = "createCompactMetadataRegistryV1"
	compactMetadataAliasResolverName = "resolveCompactMetadataAliasV1"
	compactMetadataReferenceKey      = "$tsf"
	compactMetadataImportKey         = "$tsfImport"
	compactMetadataAliasKey          = "$tsfAlias"
	compactMetadataTypeKey           = "$tsfType"
)

type compactMetadataEncoding struct {
	serialized string
	references []*shimast.Node
}

type compactMetadataEncoder struct {
	buffer           bytes.Buffer
	references       []*shimast.Node
	referenceIndexes map[string]int
	referenceKey     func(*shimast.Node) (string, bool)
	runtimeRecipe    func(*compactMetadataEncoder, *shimast.Node) bool
}

type compactMetadataRuntimeReference struct {
	name       string
	expression *shimast.Node
}

type compactMetadataRuntimeInterner struct {
	ec         *shimprinter.EmitContext
	sourceFile *shimast.SourceFile
	printer    *shimprinter.Printer
	prefix     string
	bySource   map[string]string
	entries    []compactMetadataRuntimeReference
}

func newCompactMetadataRuntimeInterner(
	ec *shimprinter.EmitContext,
	sourceFile *shimast.SourceFile,
) *compactMetadataRuntimeInterner {
	prefix := "__tsf_metadata_runtime_"
	if sourceFile != nil {
		for strings.Contains(sourceFile.Text(), prefix) {
			prefix = "_" + prefix
		}
	}
	return &compactMetadataRuntimeInterner{
		ec:         ec,
		sourceFile: sourceFile,
		printer:    shimprinter.NewPrinter(shimprinter.PrinterOptions{}, shimprinter.PrintHandlers{}, ec),
		prefix:     prefix,
		bySource:   map[string]string{},
	}
}

// reference returns a call to a shared expression factory. The factory is not
// memoized: evaluating a slot still creates a fresh arrow/object and performs
// any imported-alias lookup at the metadata expression's original first-use
// point. Only the generated AST for that expression is deduplicated.
func (interner *compactMetadataRuntimeInterner) reference(expression *shimast.Node) *shimast.Node {
	if isMetadataTypeGetterCall(expression) {
		return interner.ec.Factory.DeepCloneNode(expression)
	}
	key := interner.printer.Emit(expression, interner.sourceFile)
	name := interner.bySource[key]
	if name == "" {
		name = interner.prefix + strconv.Itoa(len(interner.entries))
		interner.bySource[key] = name
		interner.entries = append(interner.entries, compactMetadataRuntimeReference{
			name:       name,
			expression: interner.ec.Factory.DeepCloneNode(expression),
		})
	}
	return interner.ec.Factory.NewCallExpression(
		interner.ec.Factory.NewIdentifier(name),
		nil,
		nil,
		interner.ec.Factory.NewNodeList(nil),
		shimast.NodeFlagsNone,
	)
}

func isMetadataTypeGetterCall(expression *shimast.Node) bool {
	if expression == nil || expression.Kind != shimast.KindCallExpression {
		return false
	}
	call := expression.AsCallExpression()
	return call != nil && call.Expression != nil && call.Expression.Kind == shimast.KindIdentifier &&
		strings.HasPrefix(call.Expression.Text(), "__tsf_metadata_type_")
}

func isCompactMetadataAliasResolverCall(expression *shimast.Node) bool {
	if expression == nil || expression.Kind != shimast.KindCallExpression {
		return false
	}
	call := expression.AsCallExpression()
	if call == nil || call.Expression == nil || call.Expression.Kind != shimast.KindPropertyAccessExpression {
		return false
	}
	name := call.Expression.AsPropertyAccessExpression().Name()
	return name != nil && name.Text() == compactMetadataAliasResolverName
}

// deduplicationKey identifies generated runtime expressions whose value may be
// shared inside one decoded metadata graph. Class/validator thunks and primitive
// non-JSON values are immutable. Imported alias lookups clone compiler-owned
// metadata only to attach the same type name, so sharing that clone is also
// equivalent and avoids emitting hundreds of repeated factory calls for large
// DTO graphs. Arbitrary call expressions and escaped application objects remain
// distinct.
func (interner *compactMetadataRuntimeInterner) deduplicationKey(expression *shimast.Node) (string, bool) {
	if expression == nil {
		return "", false
	}
	switch expression.Kind {
	case shimast.KindArrowFunction, shimast.KindBigIntLiteral:
		return interner.printer.Emit(expression, interner.sourceFile), true
	case shimast.KindIdentifier:
		if expression.Text() == "undefined" {
			return "undefined", true
		}
	case shimast.KindCallExpression:
		if isMetadataTypeGetterCall(expression) {
			return interner.printer.Emit(expression, interner.sourceFile), true
		}
		if isCompactMetadataAliasResolverCall(expression) {
			return interner.printer.Emit(expression, interner.sourceFile), true
		}
		source := interner.printer.Emit(expression, interner.sourceFile)
		if strings.Contains(source, "__tsf_module") && strings.Contains(source, "__tsf_alias") {
			return source, true
		}
	}
	return "", false
}

func (interner *compactMetadataRuntimeInterner) declarations() []*shimast.Node {
	declarations := make([]*shimast.Node, 0, len(interner.entries))
	for _, entry := range interner.entries {
		declarations = append(declarations, expressionFactoryDeclaration(interner.ec, entry.name, entry.expression))
	}
	return declarations
}

func encodeCompactMetadata(root *shimast.Node) compactMetadataEncoding {
	return encodeCompactMetadataWithReferenceKeys(root, nil)
}

func encodeCompactMetadataWithReferenceKeys(
	root *shimast.Node,
	referenceKey func(*shimast.Node) (string, bool),
) compactMetadataEncoding {
	return encodeCompactMetadataWithRuntimeRecipes(root, referenceKey, nil)
}

func encodeCompactMetadataWithRuntimeRecipes(
	root *shimast.Node,
	referenceKey func(*shimast.Node) (string, bool),
	runtimeRecipe func(*compactMetadataEncoder, *shimast.Node) bool,
) compactMetadataEncoding {
	encoder := &compactMetadataEncoder{
		referenceIndexes: map[string]int{},
		referenceKey:     referenceKey,
		runtimeRecipe:    runtimeRecipe,
	}
	encoder.buffer.WriteString("[1,")
	encoder.writeValue(root)
	encoder.buffer.WriteByte(']')
	return compactMetadataEncoding{
		serialized: encoder.buffer.String(),
		references: encoder.references,
	}
}

func (encoder *compactMetadataEncoder) writeValue(node *shimast.Node) {
	start := encoder.buffer.Len()
	referenceStart := len(encoder.references)
	if encoder.writeJSONValue(node) {
		return
	}
	encoder.buffer.Truncate(start)
	encoder.references = encoder.references[:referenceStart]
	encoder.writeReference(node)
}

func (encoder *compactMetadataEncoder) writeJSONValue(node *shimast.Node) bool {
	if node == nil {
		return false
	}
	if encoder.runtimeRecipe != nil && encoder.runtimeRecipe(encoder, node) {
		return true
	}
	switch node.Kind {
	case shimast.KindParenthesizedExpression:
		encoder.writeValue(node.AsParenthesizedExpression().Expression)
		return true
	case shimast.KindObjectLiteralExpression:
		return encoder.writeObject(node.AsObjectLiteralExpression())
	case shimast.KindArrayLiteralExpression:
		return encoder.writeArray(node.AsArrayLiteralExpression())
	case shimast.KindStringLiteral, shimast.KindNoSubstitutionTemplateLiteral:
		encoder.writeJSONString(node.Text())
		return true
	case shimast.KindNumericLiteral:
		return encoder.writeJSONNumber(node.Text())
	case shimast.KindTrueKeyword:
		encoder.buffer.WriteString("true")
		return true
	case shimast.KindFalseKeyword:
		encoder.buffer.WriteString("false")
		return true
	case shimast.KindNullKeyword:
		encoder.buffer.WriteString("null")
		return true
	case shimast.KindPrefixUnaryExpression:
		unary := node.AsPrefixUnaryExpression()
		if unary.Operator != shimast.KindMinusToken || unary.Operand == nil || unary.Operand.Kind != shimast.KindNumericLiteral {
			return false
		}
		return encoder.writeJSONNumber("-" + unary.Operand.Text())
	default:
		return false
	}
}

func (encoder *compactMetadataEncoder) writeObject(object *shimast.ObjectLiteralExpression) bool {
	if object == nil || object.Properties == nil {
		encoder.buffer.WriteString("{}")
		return true
	}
	for _, property := range object.Properties.Nodes {
		name, ok := compactMetadataPropertyName(property)
		if !ok || name == "__proto__" {
			return false
		}
	}
	// An application-provided object with the same exact shape as a wire-format
	// reference must remain ordinary data. Escaping the small object through the
	// side table makes marker recognition unambiguous without reserving a user key.
	if len(object.Properties.Nodes) == 1 {
		if name, ok := compactMetadataPropertyName(object.Properties.Nodes[0]); ok && isCompactMetadataReservedKey(name) {
			return false
		}
	}
	encoder.buffer.WriteByte('{')
	for index, property := range object.Properties.Nodes {
		assignment := property.AsPropertyAssignment()
		name, _ := compactMetadataPropertyName(property)
		if index != 0 {
			encoder.buffer.WriteByte(',')
		}
		encoder.writeJSONString(name)
		encoder.buffer.WriteByte(':')
		encoder.writeValue(assignment.Initializer)
	}
	encoder.buffer.WriteByte('}')
	return true
}

func isCompactMetadataReservedKey(name string) bool {
	return name == compactMetadataReferenceKey || name == compactMetadataImportKey || name == compactMetadataAliasKey || name == compactMetadataTypeKey
}

func compactMetadataPropertyName(property *shimast.Node) (string, bool) {
	if property == nil || property.Kind != shimast.KindPropertyAssignment {
		return "", false
	}
	name := property.AsPropertyAssignment().Name()
	if name == nil {
		return "", false
	}
	switch name.Kind {
	case shimast.KindIdentifier, shimast.KindStringLiteral, shimast.KindNumericLiteral:
		return name.Text(), true
	default:
		return "", false
	}
}

func (encoder *compactMetadataEncoder) writeArray(array *shimast.ArrayLiteralExpression) bool {
	if array == nil || array.Elements == nil {
		encoder.buffer.WriteString("[]")
		return true
	}
	for _, element := range array.Elements.Nodes {
		if element == nil || element.Kind == shimast.KindOmittedExpression || element.Kind == shimast.KindSpreadElement {
			return false
		}
	}
	encoder.buffer.WriteByte('[')
	for index, element := range array.Elements.Nodes {
		if index != 0 {
			encoder.buffer.WriteByte(',')
		}
		encoder.writeValue(element)
	}
	encoder.buffer.WriteByte(']')
	return true
}

func (encoder *compactMetadataEncoder) writeJSONNumber(value string) bool {
	if value == "" || !json.Valid([]byte(value)) {
		return false
	}
	if _, err := strconv.ParseFloat(value, 64); err != nil {
		return false
	}
	encoder.buffer.WriteString(value)
	return true
}

func (encoder *compactMetadataEncoder) writeJSONString(value string) {
	encoded, _ := json.Marshal(value)
	encoder.buffer.Write(encoded)
}

func (encoder *compactMetadataEncoder) writeReference(node *shimast.Node) {
	key := ""
	if encoder.referenceKey != nil {
		if deduplicationKey, ok := encoder.referenceKey(node); ok {
			key = "runtime:" + deduplicationKey
		}
	}
	index := encoder.referenceIndex(node, key)
	encoder.writeReferenceMarker(index)
}

func (encoder *compactMetadataEncoder) referenceIndex(node *shimast.Node, key string) int {
	if key != "" {
		if existing, found := encoder.referenceIndexes[key]; found {
			return existing
		}
	}
	index := len(encoder.references)
	encoder.references = append(encoder.references, node)
	if key != "" {
		encoder.referenceIndexes[key] = index
	}
	return index
}

func (encoder *compactMetadataEncoder) writeReferenceMarker(index int) {
	encoder.buffer.WriteString(`{"` + compactMetadataReferenceKey + `":`)
	encoder.buffer.WriteString(strconv.Itoa(index))
	encoder.buffer.WriteByte('}')
}

func materializeCompactMetadataExpression(
	ec *shimprinter.EmitContext,
	imports *astImportRegistry,
	runtimeReferences *compactMetadataRuntimeInterner,
	template expressionTemplate,
	metadataTypeResolver string,
) *shimast.Node {
	metadata := template.materialize(ec, imports)
	return materializeCompactMetadataNode(ec, imports, runtimeReferences, metadata, metadataTypeResolver, false)
}

func materializeCompactMetadataRegistry(
	ec *shimprinter.EmitContext,
	imports *astImportRegistry,
	runtimeReferences *compactMetadataRuntimeInterner,
	templates []expressionTemplate,
	metadataTypeResolver string,
) *shimast.Node {
	elements := make([]*shimast.Node, 0, len(templates))
	for _, template := range templates {
		elements = append(elements, template.materialize(ec, imports))
	}
	metadata := ec.Factory.NewArrayLiteralExpression(ec.Factory.NewNodeList(elements), false)
	return materializeCompactMetadataNode(ec, imports, runtimeReferences, metadata, metadataTypeResolver, true)
}

func materializeCompactMetadataNode(
	ec *shimprinter.EmitContext,
	imports *astImportRegistry,
	runtimeReferences *compactMetadataRuntimeInterner,
	metadata *shimast.Node,
	metadataTypeResolver string,
	registry bool,
) *shimast.Node {
	encoding := encodeCompactMetadataWithRuntimeRecipes(
		metadata,
		runtimeReferences.deduplicationKey,
		func(encoder *compactMetadataEncoder, expression *shimast.Node) bool {
			return writeCompactMetadataRuntimeRecipe(encoder, expression, imports, metadataTypeResolver)
		},
	)
	references := make([]*shimast.Node, 0, len(encoding.references))
	for _, reference := range encoding.references {
		if imports.isOptionalModuleLoader(reference) || isCompactMetadataCommonJSRequire(reference, imports) {
			references = append(references, ec.Factory.DeepCloneNode(reference))
		} else {
			references = append(references, runtimeReferences.reference(reference))
		}
	}
	helperName := compactMetadataDecoderName
	if registry {
		helperName = compactMetadataRegistryName
	}
	arguments := []*shimast.Node{
		ec.Factory.NewStringLiteral(encoding.serialized, shimast.TokenFlagsNone),
		ec.Factory.NewArrayLiteralExpression(ec.Factory.NewNodeList(references), false),
	}
	if !registry && metadataTypeResolver != "" {
		arguments = append(arguments, ec.Factory.NewIdentifier(metadataTypeResolver))
	}
	return ec.Factory.NewCallExpression(
		imports.staticMember(compactMetadataRuntimeSpec, helperName),
		nil,
		nil,
		ec.Factory.NewNodeList(arguments),
		shimast.NodeFlagsNone,
	)
}

func writeCompactMetadataRuntimeRecipe(
	encoder *compactMetadataEncoder,
	expression *shimast.Node,
	imports *astImportRegistry,
	metadataTypeResolver string,
) bool {
	if index, ok := compactMetadataTypeRecipe(expression, metadataTypeResolver); ok {
		encoder.buffer.WriteString(`{"` + compactMetadataTypeKey + `":`)
		encoder.buffer.WriteString(strconv.Itoa(index))
		encoder.buffer.WriteByte('}')
		return true
	}
	if loader, spec, exportName, typeName, ok := compactMetadataAliasRecipe(expression, imports); ok {
		index := encoder.referenceIndex(loader, compactMetadataModuleReferenceKey(loader, imports))
		encoder.buffer.WriteString(`{"` + compactMetadataAliasKey + `":[`)
		encoder.buffer.WriteString(strconv.Itoa(index))
		encoder.buffer.WriteByte(',')
		if spec != "" {
			encoder.writeJSONString(spec)
			encoder.buffer.WriteByte(',')
		}
		encoder.writeJSONString(exportName)
		encoder.buffer.WriteByte(',')
		encoder.writeJSONString(typeName)
		encoder.buffer.WriteString("]}")
		return true
	}
	if spec, exportName, ok := compactMetadataCommonJSImportRecipe(expression); ok {
		loader := imports.ec.Factory.NewIdentifier("require")
		index := encoder.referenceIndex(loader, compactMetadataModuleReferenceKey(loader, imports))
		encoder.buffer.WriteString(`{"` + compactMetadataImportKey + `":[`)
		encoder.buffer.WriteString(strconv.Itoa(index))
		encoder.buffer.WriteByte(',')
		encoder.writeJSONString(spec)
		encoder.buffer.WriteByte(',')
		encoder.writeJSONString(exportName)
		encoder.buffer.WriteString("]}")
		return true
	}
	return false
}

func compactMetadataTypeRecipe(expression *shimast.Node, resolverName string) (int, bool) {
	if resolverName == "" || expression == nil || expression.Kind != shimast.KindCallExpression {
		return 0, false
	}
	call := expression.AsCallExpression()
	if call.Expression == nil || call.Expression.Kind != shimast.KindIdentifier || call.Expression.Text() != resolverName ||
		call.Arguments == nil || len(call.Arguments.Nodes) != 1 || call.Arguments.Nodes[0].Kind != shimast.KindNumericLiteral {
		return 0, false
	}
	index, err := strconv.Atoi(call.Arguments.Nodes[0].Text())
	return index, err == nil && index >= 0
}

func compactMetadataAliasRecipe(
	expression *shimast.Node,
	imports *astImportRegistry,
) (*shimast.Node, string, string, string, bool) {
	if !isCompactMetadataAliasResolverCall(expression) {
		return nil, "", "", "", false
	}
	call := expression.AsCallExpression()
	if call.Arguments == nil {
		return nil, "", "", "", false
	}
	arguments := call.Arguments.Nodes
	if len(arguments) == 3 && imports.isOptionalModuleLoader(arguments[0]) && shimast.IsStringLiteral(arguments[1]) && shimast.IsStringLiteral(arguments[2]) {
		return arguments[0], "", arguments[1].Text(), arguments[2].Text(), true
	}
	if len(arguments) == 4 && isCompactMetadataCommonJSRequire(arguments[0], imports) &&
		shimast.IsStringLiteral(arguments[1]) && shimast.IsStringLiteral(arguments[2]) && shimast.IsStringLiteral(arguments[3]) {
		return arguments[0], arguments[1].Text(), arguments[2].Text(), arguments[3].Text(), true
	}
	return nil, "", "", "", false
}

func isCompactMetadataCommonJSRequire(expression *shimast.Node, imports *astImportRegistry) bool {
	return imports.commonJS && expression != nil && expression.Kind == shimast.KindIdentifier && expression.Text() == "require"
}

func compactMetadataModuleReferenceKey(expression *shimast.Node, imports *astImportRegistry) string {
	if isCompactMetadataCommonJSRequire(expression, imports) {
		return "module:require"
	}
	return "loader:" + expression.Text()
}

func compactMetadataCommonJSImportRecipe(expression *shimast.Node) (string, string, bool) {
	if expression == nil || expression.Kind != shimast.KindArrowFunction {
		return "", "", false
	}
	body := expression.AsArrowFunction().Body
	for body != nil && body.Kind == shimast.KindParenthesizedExpression {
		body = body.AsParenthesizedExpression().Expression
	}
	if body == nil || body.Kind != shimast.KindConditionalExpression {
		return "", "", false
	}
	conditional := body.AsConditionalExpression()
	whenFalse := conditional.WhenFalse
	if whenFalse == nil || whenFalse.Kind != shimast.KindIdentifier || whenFalse.Text() != "undefined" {
		return "", "", false
	}
	whenTrue := conditional.WhenTrue
	if whenTrue == nil || whenTrue.Kind != shimast.KindPropertyAccessExpression {
		return "", "", false
	}
	property := whenTrue.AsPropertyAccessExpression()
	if property.Expression == nil || property.Expression.Kind != shimast.KindCallExpression || property.Name() == nil {
		return "", "", false
	}
	call := property.Expression.AsCallExpression()
	if call.Expression == nil || call.Expression.Kind != shimast.KindIdentifier || call.Expression.Text() != "require" ||
		call.Arguments == nil || len(call.Arguments.Nodes) != 1 || !shimast.IsStringLiteral(call.Arguments.Nodes[0]) {
		return "", "", false
	}
	return call.Arguments.Nodes[0].Text(), property.Name().Text(), true
}

func expressionFactoryDeclaration(ec *shimprinter.EmitContext, name string, expression *shimast.Node) *shimast.Node {
	return ec.Factory.NewVariableStatement(
		nil,
		ec.Factory.NewVariableDeclarationList(
			ec.Factory.NewNodeList([]*shimast.Node{ec.Factory.NewVariableDeclaration(
				ec.Factory.NewIdentifier(name),
				nil,
				nil,
				ec.Factory.NewArrowFunction(
					nil,
					nil,
					ec.Factory.NewNodeList(nil),
					nil,
					nil,
					ec.Factory.NewToken(shimast.KindEqualsGreaterThanToken),
					expression,
				),
			)}),
			shimast.NodeFlagsConst,
		),
	)
}
