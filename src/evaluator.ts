import { runSelectQuery, runConstructQuery } from './sparqlClient';
import { OM, PARX, DINEN61360, RDF } from './namespaces';
import { evaluate } from 'mathjs';
import { Node, Literal, NamedNode, graph, parse } from 'rdflib';

/**
 * Evaluates a formula by finding the corresponding process and data element
 * @param processUri URI of process operator
 * @param outputDEUri URI of data element
 * @param endpoint SPARQL endpoint
 * @returns Result of the evaluation
 */



function sparqlTerm(uri: string): string {
  if (!uri) return uri;

  if (uri.startsWith('<') || uri.startsWith('_:')) return uri;

  if (uri.startsWith('http://') || uri.startsWith('https://')) return `<${uri}>`;
  return uri;
}

/**
 * Loads entire formula structure into in-memory graph
 */
async function loadFormulaGraph(formulaUri: string, endpoint: string): Promise<any> {
  // Use a simpler approach: get all triples connected to the formula via any path
  const q = `
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>

CONSTRUCT {
  ?s ?p ?o .
}
WHERE {
  {
    # Direct properties of formula
    <${formulaUri}> ?p ?o .
    BIND(<${formulaUri}> AS ?s)
  }
  UNION
  {
    # Traverse all nested nodes (arguments lists, blank nodes, etc.)
    <${formulaUri}> (om:arguments|rdf:first|rdf:rest|om:operator|rdf:type)* ?s .
    ?s ?p ?o .
  }
}`;

  const turtle = await runConstructQuery(q, endpoint);
  const store = graph();
  parse(turtle, store, 'http://example.org/', 'text/turtle');
  return store;
}

/**
 * Gets the operator URI from an in-memory graph node
 */
function getOperatorFromGraph(store: any, nodeUri: string): string | null {
  const node = nodeUri.startsWith('_:')
    ? store.bnode(nodeUri.substring(2))
    : store.sym(nodeUri);
  const opPred = store.sym(OM('operator').value);
  const stmts = store.statementsMatching(node, opPred, null);
  return stmts.length > 0 ? stmts[0].object.value : null;
}

/**
 * Gets arguments from RDF list in memory
 */
function getArgsFromGraph(store: any, nodeUri: string): any[] {
  const node = nodeUri.startsWith('_:')
    ? store.bnode(nodeUri.substring(2))
    : store.sym(nodeUri);
  const argsPred = store.sym(OM('arguments').value);
  const firstPred = store.sym(RDF('first').value);
  const restPred = store.sym(RDF('rest').value);

  const argsStmts = store.statementsMatching(node, argsPred, null);
  if (argsStmts.length === 0) return [];

  const listHead = argsStmts[0].object;

  // Handle rdflib Collection objects (used for RDF lists in parsed Turtle)
  if (listHead.termType === 'Collection' && listHead.elements) {
    return listHead.elements;
  }

  // Fallback: traverse rdf:first/rdf:rest manually
  const args: any[] = [];
  let current = listHead;

  while (current && current.value !== RDF('nil').value) {
    const firstStmts = store.statementsMatching(current, firstPred, null);
    if (firstStmts.length > 0) {
      args.push(firstStmts[0].object);
    }
    const restStmts = store.statementsMatching(current, restPred, null);
    if (restStmts.length > 0) {
      current = restStmts[0].object;
    } else {
      break;
    }
  }

  return args;
}

/**
 * Checks if a node is an om:Application in the graph
 */
function isApplication(store: any, node: any): boolean {
  const typePred = store.sym(RDF('type').value);
  const appType = store.sym(OM('Application').value);
  const stmts = store.statementsMatching(node, typePred, appType);
  return stmts.length > 0;
}

/**
 * Checks if a node is an om:Variable in the graph
 */
function isVariable(store: any, node: any): boolean {
  const typePred = store.sym(RDF('type').value);
  const varType = store.sym(OM('Variable').value);
  const stmts = store.statementsMatching(node, typePred, varType);
  return stmts.length > 0;
}

/**
 * Build expression from in-memory graph
 */
async function buildExprFromGraph(
  store: any,
  nodeUri: string,
  endpoint: string,
  checkContext: IntermediateCheckContext
): Promise<{ expression: string, variables: Record<string, number> }> {
  const opUri = getOperatorFromGraph(store, nodeUri);
  if (!opUri) {
    throw new Error(`No operator found for node: ${nodeUri}`);
  }

  // Handle equality - get RHS
  if (opUri.endsWith('#eq')) {
    const args = getArgsFromGraph(store, nodeUri);
    if (args.length < 2) {
      throw new Error('Equality requires 2 arguments');
    }
    const rhsNode = args[1];
    const rhsUri = rhsNode.termType === 'BlankNode' ? `_:${rhsNode.value}` : rhsNode.value;
    return buildExprFromGraph(store, rhsUri, endpoint, checkContext);
  }

  const args = getArgsFromGraph(store, nodeUri);
  const vars: Record<string, number> = {};
  const parts: string[] = [];

  for (const arg of args) {
    // Literal value
    if (arg.termType === 'Literal') {
      parts.push(arg.value);
      continue;
    }

    const argUri = arg.termType === 'BlankNode' ? `_:${arg.value}` : arg.value;

    // Check if it's an Application (nested formula)
    if (isApplication(store, arg)) {
      const nested = await buildExprFromGraph(store, argUri, endpoint, checkContext);
      Object.assign(vars, nested.variables);
      parts.push(`(${nested.expression})`);
      continue;
    }

    // Check if it's a Variable
    if (isVariable(store, arg) || arg.termType === 'NamedNode') {
      const varIri = arg.value;
      const name = varIri.replace(/^.*[\/#]/, '');

      // Check cache first
      if (checkContext.resolvedVars.has(varIri)) {
        vars[name] = checkContext.resolvedVars.get(varIri)!;
        parts.push(name);
        continue;
      }

      // Try to get direct value
      const direct = await getVarValue(varIri, endpoint);
      if (direct !== null) {
        vars[name] = direct;
        checkContext.resolvedVars.set(varIri, direct);
        parts.push(name);
        continue;
      }

      // Try to resolve via formula
      const val = await resolveVar(varIri, endpoint, new Set(), checkContext);
      vars[name] = val;
      checkContext.resolvedVars.set(varIri, val);
      parts.push(name);
      continue;
    }

    throw new Error(`Unknown argument type: ${arg.termType}`);
  }

  const op = getOperator(opUri);
  const expr = op.arity === 1
    ? `${op.symbol}(${parts.join(', ')})`
    : parts.join(` ${op.symbol} `);

  return { expression: expr, variables: vars };
}


async function getVarValue(varIri: string, endpoint: string): Promise<number | null> {
  const q = `
    PREFIX DINEN61360:  <http://www.w3id.org/hsu-aut/DINEN61360#>
    PREFIX ParX: <http://www.hsu-hh.de/aut/ParX#>
    SELECT ?val WHERE {
      ?de ParX:isDataFor <${varIri}> ;
          DINEN61360:has_Instance_Description ?desc .
      ?desc DINEN61360:Value ?val .
    } LIMIT 1`;
  const res = await runSelectQuery(q, endpoint);
  const bindings = res.results.bindings;
  if (bindings.length === 0) return null;
  return Number(bindings[0].val.value);
}

async function getDataElementForVar(varIri: string, endpoint: string): Promise<string | null> {
  const q = `
    PREFIX ParX: <http://www.hsu-hh.de/aut/ParX#>
    SELECT ?de WHERE {
      ?de ParX:isDataFor <${varIri}> .
    } LIMIT 1`;
  const res = await runSelectQuery(q, endpoint);
  const bindings = res.results.bindings;
  if (bindings.length === 0) return null;
  return bindings[0].de.value;
}
async function findFormulaForVar(varIri: string, endpoint: string): Promise<string | null> {
  const q = `
    PREFIX om:   <http://openmath.org/vocab/math#>
    PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX ParX: <http://www.hsu-hh.de/aut/ParX#>
    SELECT ?f WHERE {
      ?proc ParX:hasInterdependency ?f .
      ?f om:operator <http://www.openmath.org/cd/relation1#eq> ;
         om:arguments ?args .
      ?args rdf:first <${varIri}> .
    } LIMIT 1`;
  const res = await runSelectQuery(q, endpoint);
  const bindings = res.results.bindings;
  return bindings.length ? bindings[0].f.value : null;
}


interface IntermediateCheckContext {
  warnings: RestrictionWarning[];
  checkedCount: number;
  resolvedVars: Map<string, number>;
}

async function resolveVar(
  varIri: string,
  endpoint: string,
  visited: Set<string> = new Set(),
  checkContext: IntermediateCheckContext = { warnings: [], checkedCount: 0, resolvedVars: new Map() }
): Promise<number> {
  // Return cached value if already resolved
  if (checkContext.resolvedVars.has(varIri)) {
    return checkContext.resolvedVars.get(varIri)!;
  }

  if (visited.has(varIri)) {
    throw new Error(`Cyclic dependency detected: ${varIri}`);
  }
  visited.add(varIri);

  const direct = await getVarValue(varIri, endpoint);
  if (direct !== null) {
    checkContext.resolvedVars.set(varIri, direct);
    return direct;
  }

  const formulaIri = await findFormulaForVar(varIri, endpoint);
  if (!formulaIri) {
    throw new Error(`No value or formula found for: ${varIri}`);
  }

  const { expression, variables } = await buildExprWithWarnings(formulaIri, endpoint, checkContext);
  const withValues = expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, name => {
    if (variables[name] !== undefined) return variables[name].toString();
    throw new Error(`Missing value: ${name}`);
  });
  const result = Number(evaluate(withValues));

  // Cache the resolved value
  checkContext.resolvedVars.set(varIri, result);

  // Check restrictions for this intermediate result
  const dataElementUri = await getDataElementForVar(varIri, endpoint);
  if (dataElementUri) {
    const { warnings, checkedCount } = await checkRestrictions(dataElementUri, result, endpoint);
    checkContext.checkedCount += checkedCount;
    for (const w of warnings) {
      const varName = varIri.replace(/^.*[\/#]/, '');
      w.message = `[Intermediate: ${varName}] ${w.message}`;
      checkContext.warnings.push(w);
    }
  }

  return result;
}


/**
 * Result of symbolic formula expression (without evaluation)
 */
export interface FormulaExpressionResult {
  expression: string;
  outputVar: string;
}

/**
 * Get the symbolic expression of a formula without evaluating it
 * @param formulaUri - The IRI of the formula (Interdependency)
 * @param sparqlEndpoint - The SPARQL endpoint URL
 * @returns The formula expression as a string (e.g., "V = l * w * h") and output variable URI
 */
export async function getFormulaExpression(
  formulaUri: string,
  sparqlEndpoint: string
): Promise<FormulaExpressionResult> {
  const store = await loadFormulaGraph(formulaUri, sparqlEndpoint);

  // Get the output variable (LHS of equation)
  const outputVar = getOutputVarFromGraph(store, formulaUri);
  const outputVarName = outputVar.replace(/^.*[\/#]/, '');

  // Build symbolic expression (RHS only)
  const rhsExpr = await buildSymbolicExpr(store, formulaUri);

  return {
    expression: `${outputVarName} = ${rhsExpr}`,
    outputVar
  };
}

/**
 * Get the output variable (LHS) from an equation in the graph
 */
function getOutputVarFromGraph(store: any, formulaUri: string): string {
  const node = formulaUri.startsWith('_:')
    ? store.bnode(formulaUri.substring(2))
    : store.sym(formulaUri);

  const opPred = store.sym(OM('operator').value);
  const opStmts = store.statementsMatching(node, opPred, null);

  if (opStmts.length === 0 || !opStmts[0].object.value.endsWith('#eq')) {
    throw new Error('Formula must be an equation (om:operator = relation1#eq)');
  }

  const args = getArgsFromGraph(store, formulaUri);
  if (args.length < 1) {
    throw new Error('Equation must have at least one argument (LHS)');
  }

  return args[0].value;
}

/**
 * Build symbolic expression from graph without resolving variable values
 */
async function buildSymbolicExpr(store: any, nodeUri: string): Promise<string> {
  const opUri = getOperatorFromGraph(store, nodeUri);
  if (!opUri) {
    throw new Error(`No operator found for node: ${nodeUri}`);
  }

  // Handle equality - get RHS
  if (opUri.endsWith('#eq')) {
    const args = getArgsFromGraph(store, nodeUri);
    if (args.length < 2) {
      throw new Error('Equality requires 2 arguments');
    }
    const rhsNode = args[1];
    const rhsUri = rhsNode.termType === 'BlankNode' ? `_:${rhsNode.value}` : rhsNode.value;
    return buildSymbolicExpr(store, rhsUri);
  }

  const args = getArgsFromGraph(store, nodeUri);
  const parts: string[] = [];

  for (const arg of args) {
    // Literal value
    if (arg.termType === 'Literal') {
      parts.push(arg.value);
      continue;
    }

    const argUri = arg.termType === 'BlankNode' ? `_:${arg.value}` : arg.value;

    // Check if it's an Application (nested formula)
    if (isApplication(store, arg)) {
      const nested = await buildSymbolicExpr(store, argUri);
      parts.push(`(${nested})`);
      continue;
    }

    // Variable - just use the name
    if (isVariable(store, arg) || arg.termType === 'NamedNode') {
      const name = arg.value.replace(/^.*[\/#]/, '');
      parts.push(name);
      continue;
    }

    throw new Error(`Unknown argument type: ${arg.termType}`);
  }

  const op = getOperator(opUri);
  return op.arity === 1
    ? `${op.symbol}(${parts.join(', ')})`
    : parts.join(` ${op.symbol} `);
}

/**
 * Result of formula evaluation including optional restriction warnings
 */
export interface EvaluationResult {
  expression: string;
  result: number;
  warnings?: RestrictionWarning[];
  restrictionsChecked?: number;
}

/**
 * Evaluate formula for a process output
 * @param processUri URI of the process
 * @param outputUri URI of the output data element
 * @param endpoint SPARQL endpoint
 * @param checkRestrictions Whether to check restrictions (default: true)
 * @returns Expression, calculated result, and any restriction warnings
 */
export async function evaluateByProcess(
  processUri: string,
  outputUri: string,
  endpoint: string,
  doCheckRestrictions: boolean = true
): Promise<EvaluationResult> {
  const formulaUri = await findFormula(processUri, outputUri, endpoint);

  // Use buildExprWithWarnings to collect intermediate warnings
  const checkContext: IntermediateCheckContext = { warnings: [], checkedCount: 0, resolvedVars: new Map() };
  const { expression, variables } = await buildExprWithWarnings(formulaUri, endpoint, checkContext);

  const withValues = expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, name => {
    if (variables[name] !== undefined) return variables[name].toString();
    throw new Error(`Missing value: ${name}`);
  });

  const result = evaluate(withValues);

  if (doCheckRestrictions) {
    // Check final output restrictions
    const { warnings: finalWarnings, checkedCount: finalCheckedCount } = await checkRestrictions(outputUri, result, endpoint);
    const allWarnings = [...checkContext.warnings, ...finalWarnings];
    const totalChecked = checkContext.checkedCount + finalCheckedCount;
    return { expression: withValues, result, warnings: allWarnings, restrictionsChecked: totalChecked };
  }

  return { expression: withValues, result };
}

async function findFormula(processUri: string, dataElementUri: string, endpoint: string): Promise<string> {
  const q = `
PREFIX ParX: <${PARX('').value}>
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>
SELECT ?formula WHERE {
  <${processUri}> ParX:hasInterdependency ?formula .
  ?formula om:arguments ?args .
  ?args rdf:first ?lhs .
  ?lhs a om:Variable .
  ?de ParX:isDataFor ?lhs .
  FILTER(str(?de) = "${dataElementUri}")
} LIMIT 1`;

  const res = await runSelectQuery(q, endpoint);
  if (res.results.bindings.length === 0) {
    throw new Error('No formula found.');
  }
  return res.results.bindings[0].formula.value;
}

/**
 * Evaluate a formula by its URI
 * @param formulaUri URI of the formula
 * @param endpoint SPARQL endpoint
 * @returns Expression, calculated result, intermediate warnings and check count
 */
export async function evaluateFormula(formulaUri: string, endpoint: string): Promise<{ expression: string, result: number, intermediateWarnings: RestrictionWarning[], intermediateCheckedCount: number }> {
  const checkContext: IntermediateCheckContext = { warnings: [], checkedCount: 0, resolvedVars: new Map() };
  const { expression, variables } = await buildExprWithWarnings(formulaUri, endpoint, checkContext);

  const withValues = expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, name => {
    if (variables[name] !== undefined) return variables[name].toString();
    throw new Error(`Missing value: ${name}`);
  });

  const result = evaluate(withValues);
  return { expression: withValues, result, intermediateWarnings: checkContext.warnings, intermediateCheckedCount: checkContext.checkedCount };
}

async function buildExprWithWarnings(
  nodeUri: string,
  endpoint: string,
  checkContext: IntermediateCheckContext = { warnings: [], checkedCount: 0, resolvedVars: new Map() }
): Promise<{ expression: string, variables: Record<string, number>, checkContext: IntermediateCheckContext }> {
  // Load formula graph and use in-memory traversal (handles blank nodes correctly)
  const store = await loadFormulaGraph(nodeUri, endpoint);
  const result = await buildExprFromGraph(store, nodeUri, endpoint, checkContext);
  return { ...result, checkContext };
}

const OP_MAP: Record<string, { symbol: string; arity: 1 | 2 }> = {
  
  'http://www.openmath.org/cd/arith1#plus':   { symbol: '+', arity: 2 },
  'http://www.openmath.org/cd/arith1#times':  { symbol: '*', arity: 2 },
  'http://www.openmath.org/cd/arith1#divide': { symbol: '/', arity: 2 },
  'http://www.openmath.org/cd/arith1#minus':  { symbol: '-', arity: 2 },
  'http://www.openmath.org/cd/arith1#power':  { symbol: '^', arity: 2 },
  'http://www.openmath.org/cd/arith1#root':   { symbol: 'nthRoot', arity: 2 },
  
  'http://www.openmath.org/cd/arith1#abs':    { symbol: 'abs', arity: 1 },
  'http://www.openmath.org/cd/arith1#sqrt':   { symbol: 'sqrt', arity: 1 },
  'http://www.openmath.org/cd/transc1#exp':   { symbol: 'exp', arity: 1 },
  'http://www.openmath.org/cd/transc1#ln':    { symbol: 'log', arity: 1 },
  'http://www.openmath.org/cd/transc1#log':   { symbol: 'log10', arity: 1 },
};

function getOperator(opUri: string): { symbol: string; arity: 1 | 2 } {
  const op = OP_MAP[opUri];
  if (!op) throw new Error(`Unsupported operator: ${opUri}`);
  return op;
}

/**
 * Restriction warning returned when a calculated value violates a constraint
 */
export interface RestrictionWarning {
  restrictionDE: string;
  logic: string;
  limitValue: number;
  actualValue: number;
  message: string;
}

/**
 * Logic operators for restriction checking
 */
const LOGIC_OPS: Record<string, (actual: number, limit: number) => boolean> = {
  '<=': (a, l) => a <= l,
  '>=': (a, l) => a >= l,
  '<':  (a, l) => a < l,
  '>':  (a, l) => a > l,
  '=':  (a, l) => a === l,
  '==': (a, l) => a === l,
};

/**
 * Result of restriction check
 */
export interface RestrictionCheckResult {
  warnings: RestrictionWarning[];
  checkedCount: number;
}

/**
 * Check if a calculated result violates any restrictions on the output data element
 * @param dataElementUri URI of the output data element
 * @param calculatedValue The calculated result to check
 * @param endpoint SPARQL endpoint
 * @returns Object with warnings array and count of checked restrictions
 */
export async function checkRestrictions(
  dataElementUri: string,
  calculatedValue: number,
  endpoint: string
): Promise<RestrictionCheckResult> {
  const q = `
    PREFIX ParX: <${PARX('').value}>
    PREFIX DINEN61360: <${DINEN61360('').value}>
    SELECT ?restrictionDE ?logic ?limitValue WHERE {
      <${dataElementUri}> ParX:isRestrictedBy ?restrictionDE .
      ?restrictionDE DINEN61360:has_Instance_Description ?desc .
      ?desc DINEN61360:Logic_Interpretation ?logic ;
            DINEN61360:Value ?limitValue ;
            DINEN61360:Expression_Goal "Requirement" .
    }`;

  const res = await runSelectQuery(q, endpoint);
  const bindings = res.results.bindings;
  const warnings: RestrictionWarning[] = [];
  const checkedCount = bindings.length;

  for (const b of bindings) {
    const logic = b.logic.value;
    const limitValue = parseFloat(b.limitValue.value);
    const restrictionDE = b.restrictionDE.value;

    const checkFn = LOGIC_OPS[logic];
    if (!checkFn) {
      warnings.push({
        restrictionDE,
        logic,
        limitValue,
        actualValue: calculatedValue,
        message: `Unknown logic operator: ${logic}`
      });
      continue;
    }

    const satisfied = checkFn(calculatedValue, limitValue);
    if (!satisfied) {
      const deName = restrictionDE.replace(/^.*[\/#]/, '');
      warnings.push({
        restrictionDE,
        logic,
        limitValue,
        actualValue: calculatedValue,
        message: `Restriction violated: ${calculatedValue} ${logic} ${limitValue} (from ${deName})`
      });
    }
  }

  return { warnings, checkedCount };
}

