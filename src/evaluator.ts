import { runSelectQuery } from './sparqlClient';
import { OM, PARX, DINEN61360, RDF } from './namespaces';
import { evaluate } from 'mathjs';
import { Node, Literal, NamedNode } from 'rdflib';

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


async function resolveVar(
  varIri: string,
  endpoint: string,
  visited: Set<string> = new Set(),
  collectedWarnings: RestrictionWarning[] = []
): Promise<number> {
  if (visited.has(varIri)) {
    throw new Error(`Cyclic dependency detected: ${varIri}`);
  }
  visited.add(varIri);

  const direct = await getVarValue(varIri, endpoint);
  if (direct !== null) return direct;

  const formulaIri = await findFormulaForVar(varIri, endpoint);
  if (!formulaIri) {
    throw new Error(`No value or formula found for: ${varIri}`);
  }

  const { expression, variables, intermediateWarnings } = await buildExprWithWarnings(formulaIri, endpoint, collectedWarnings);
  const withValues = expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, name => {
    if (variables[name] !== undefined) return variables[name].toString();
    throw new Error(`Missing value: ${name}`);
  });
  const result = Number(evaluate(withValues));

  // Check restrictions for this intermediate result
  const dataElementUri = await getDataElementForVar(varIri, endpoint);
  if (dataElementUri) {
    const { warnings } = await checkRestrictions(dataElementUri, result, endpoint);
    for (const w of warnings) {
      const varName = varIri.replace(/^.*[\/#]/, '');
      w.message = `[Intermediate: ${varName}] ${w.message}`;
      collectedWarnings.push(w);
    }
  }

  return result;
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
  const collectedWarnings: RestrictionWarning[] = [];
  const { expression, variables, intermediateWarnings } = await buildExprWithWarnings(formulaUri, endpoint, collectedWarnings);

  const withValues = expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, name => {
    if (variables[name] !== undefined) return variables[name].toString();
    throw new Error(`Missing value: ${name}`);
  });

  const result = evaluate(withValues);

  if (doCheckRestrictions) {
    // Check final output restrictions
    const { warnings: finalWarnings, checkedCount } = await checkRestrictions(outputUri, result, endpoint);
    const allWarnings = [...intermediateWarnings, ...finalWarnings];
    const totalChecked = checkedCount + intermediateWarnings.length;
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
 * @returns Expression and calculated result
 */
export async function evaluateFormula(formulaUri: string, endpoint: string): Promise<{ expression: string, result: number }> {
  const { expression, variables } = await buildExpr(formulaUri, endpoint);

  const withValues = expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, name => {
    if (variables[name] !== undefined) return variables[name].toString();
    throw new Error(`Missing value: ${name}`);
  });

  const result = evaluate(withValues);
  return { expression: withValues, result };
}

async function buildExprWithWarnings(
  nodeUri: string,
  endpoint: string,
  collectedWarnings: RestrictionWarning[] = []
): Promise<{ expression: string, variables: Record<string, number>, intermediateWarnings: RestrictionWarning[] }> {
  return buildExprInternal(nodeUri, endpoint, collectedWarnings);
}

async function buildExpr(nodeUri: string, endpoint: string): Promise<{ expression: string, variables: Record<string, number> }> {
  const result = await buildExprInternal(nodeUri, endpoint, []);
  return { expression: result.expression, variables: result.variables };
}

async function buildExprInternal(
  nodeUri: string,
  endpoint: string,
  collectedWarnings: RestrictionWarning[]
): Promise<{ expression: string, variables: Record<string, number>, intermediateWarnings: RestrictionWarning[] }> {
  const opQuery = `
PREFIX om: <${OM('').value}>
SELECT ?op WHERE { ${sparqlTerm(nodeUri)} om:operator ?op } LIMIT 1`;
  const opRes = await runSelectQuery(opQuery, endpoint);
  const opUri = opRes.results.bindings[0].op.value;

  if (opUri.endsWith('#eq')) {
    const rhsQuery = `
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>
SELECT ?rhs WHERE {
   ${sparqlTerm(nodeUri)} om:arguments ?args .
  ?args rdf:rest ?tail .
  ?tail rdf:first ?rhs .
}`;
    const rhsRes = await runSelectQuery(rhsQuery, endpoint);
    const b = rhsRes.results.bindings[0].rhs;
    const rhsNode = b.type === 'bnode' ? `_:${b.value}` : b.value;
    return await buildExprInternal(rhsNode, endpoint, collectedWarnings);
  }

  const args = await getArgs(nodeUri, endpoint);
  const vars: Record<string, number> = {};
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const arg of args) {
    if (arg.termType === 'Literal') {
      parts.push((arg as Literal).value);
      continue;
    }

    if (arg.termType !== 'NamedNode') {
      throw new Error(`Unsupported node type: ${arg.termType}`);
    }

    const argUri = (arg as NamedNode).value;

    const typeQuery = `
PREFIX om: <${OM('').value}>
SELECT ?type WHERE { ${sparqlTerm(argUri)} a ?type }`;
    const typeRes = await runSelectQuery(typeQuery, endpoint);
    const types = typeRes.results.bindings.map((b: any) => b.type.value);

    if (types.includes(OM('Variable').value) && !types.includes(OM('Application').value)) {
      const valQuery = `
PREFIX ParX: <${PARX('').value}>
PREFIX DINEN61360: <${DINEN61360('').value}>
PREFIX om: <${OM('').value}>

SELECT ?val ?name WHERE {
  ${sparqlTerm(argUri)} a om:Variable .
  BIND(REPLACE(STR(${sparqlTerm(argUri)}), ".*[#/](.+)$", "$1") AS ?name)
  ?de ParX:isDataFor ${sparqlTerm(argUri)} ;
      DINEN61360:has_Instance_Description ?desc .
  ?desc DINEN61360:Value ?val .
} LIMIT 1`;

      const valRes = await runSelectQuery(valQuery, endpoint);
      if (valRes.results.bindings.length > 0) {
        const b: any = valRes.results.bindings[0];
        vars[b.name.value] = parseFloat(b.val.value);
        parts.push(b.name.value);
        continue;
      }
      
const name = argUri.replace(/^.*[\/#]/, '');
const val = await resolveVar(argUri, endpoint, new Set(), collectedWarnings);     
vars[name] = val;                       
parts.push(name);
continue;

    } else if (types.includes(OM('Application').value)) {
      const nested = await buildExprInternal(argUri, endpoint, collectedWarnings);
      Object.assign(vars, nested.variables);
      if (!seen.has(nested.expression)) {
        parts.push(`(${nested.expression})`);
        seen.add(nested.expression);
      }
      continue;
    }

    throw new Error(`Unknown type: ${argUri}`);
  }

  const op = getOperator(opUri);
  const expr = op.arity === 1
    ? `${op.symbol}(${parts.join(', ')})`
    : parts.join(` ${op.symbol} `);

  return { expression: expr, variables: vars, intermediateWarnings: collectedWarnings };
}

async function getArgs(nodeUri: string, endpoint: string): Promise<Node[]> {
  const firstQ = `
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>
SELECT ?arg WHERE {
  ${sparqlTerm(nodeUri)} om:arguments/rdf:first ?arg .
}`;

  const firstRes = await runSelectQuery(firstQ, endpoint);
  const first = firstRes.results.bindings[0]?.arg;
  
  if (!first) return [];
  
  const secondQ = `
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>
SELECT ?arg WHERE {
  ${sparqlTerm(nodeUri)} om:arguments/rdf:rest/rdf:first ?arg .
}`;

  const secondRes = await runSelectQuery(secondQ, endpoint);
  const second = secondRes.results.bindings[0]?.arg;
  
  const args = [first];
  if (second) args.push(second);
  
  return args.map((b: any) => {
    if (b.type === 'literal') {
      return { termType: 'Literal', value: b.value } as Literal;
    }
    const val = b.type === 'bnode' ? `_:${b.value}` : b.value;
    return { termType: 'NamedNode', value: val } as NamedNode;
  });
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

