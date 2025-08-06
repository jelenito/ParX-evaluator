import { runSelectQuery } from './sparqlClient';
import { OM, PARX, DINEN61360, RDF } from './namespaces';
import { evaluate } from 'mathjs';
import { Node, Literal, NamedNode } from 'rdflib';

/**
 * Evaluates a formula by finding the corresponding process operator and data element.
 * @param processUri URI of process operator
 * @param outputDEUri URI of data element
 * @param endpoint SPARQL-Endpoint
 * @returns Ergebniswert und ausgewerteter Ausdruck
 */

const valueCache: Record<string, number> = {};

export async function evaluateFormulaByProcess(processUri: string, outputDEUri: string, endpoint: string): Promise<{ expression: string, result: number }> {
  const formulaUri = await findFormulaUri(processUri, outputDEUri, endpoint);
  return evaluateFormula(formulaUri, endpoint);
}

async function findFormulaUri(processUri: string, dataElementUri: string, endpoint: string): Promise<string> {
  const query = `
PREFIX parx: <${PARX('').value}>
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>
SELECT ?formula WHERE {
  <${processUri}> parx:hasInterdependency ?formula .
  ?formula om:arguments ?argList .
  ?argList rdf:first ?lhs .
  ?lhs a om:Variable .
  ?de parx:isDataFor ?lhs .
  FILTER(str(?de) = "${dataElementUri}")
} LIMIT 1`;

  const res = await runSelectQuery(query, endpoint);
  if (res.results.bindings.length === 0) {
    throw new Error('No formula found for the given request.');
  }
  return res.results.bindings[0].formula.value;
}

export async function evaluateFormula(formulaUri: string, endpoint: string): Promise<{ expression: string, result: number }> {
  const { expression, variables } = await buildExpression(formulaUri, endpoint);

  const exprWithValues = expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, name => {
    if (variables[name] !== undefined) return variables[name].toString();
    throw new Error(`Missing value for: ${name}`);
  });

  const result = evaluate(exprWithValues);
  return { expression: exprWithValues, result };
}

async function buildExpression(nodeUri: string, endpoint: string): Promise<{ expression: string, variables: Record<string, number> }> {
  const operatorQuery = `
PREFIX om: <${OM('').value}>
SELECT ?op WHERE { <${nodeUri}> om:operator ?op } LIMIT 1`;
  const opResult = await runSelectQuery(operatorQuery, endpoint);
  const operatorUri = opResult.results.bindings[0].op.value;

  if (operatorUri.endsWith('#eq')) {
    const rhsQuery = `
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>
SELECT ?rhs WHERE {
  <${nodeUri}> om:arguments ?list .
  ?list rdf:rest ?tail .
  ?tail rdf:first ?rhs .
}`;
    const rhsResult = await runSelectQuery(rhsQuery, endpoint);
    const rhsNode = rhsResult.results.bindings[0].rhs.value;
    return await buildExpression(rhsNode, endpoint);
  }

  const argNodes = await getArgumentsViaPathQuery(nodeUri, endpoint);
  const variables: Record<string, number> = {};
  const argsByOrder: string[] = [];
  const expressionCache = new Set<string>();

  for (const arg of argNodes) {
    if (arg.termType === 'Literal') {
      argsByOrder.push((arg as Literal).value);
      continue;
    }

    if (arg.termType !== 'NamedNode') {
      throw new Error(`not supported Node-Type: ${arg.termType}`);
    }

    const argUri = (arg as NamedNode).value;

    const typeQuery = `
PREFIX om: <${OM('').value}>
SELECT ?type WHERE { <${argUri}> a ?type }`;
    const typeRes = await runSelectQuery(typeQuery, endpoint);
    const types = typeRes.results.bindings.map((b: any) => b.type.value);

    if (types.includes(OM('Variable').value) && !types.includes(OM('Application').value)) {
      const valueQuery = `
PREFIX parx: <${PARX('').value}>
PREFIX din61360: <${DINEN61360('').value}>
PREFIX om: <${OM('').value}>

SELECT ?val ?varname WHERE {
  <${argUri}> a om:Variable .
  BIND(REPLACE(STR(<${argUri}>), ".*[#/](.+)$", "$1") AS ?varname)
  ?de parx:isDataFor <${argUri}> ;
      din61360:hasInstanceDescription ?desc .
  ?desc din61360:value ?val .
} LIMIT 1`;

      const valRes = await runSelectQuery(valueQuery, endpoint);
      if (valRes.results.bindings.length > 0) {
        const b: any = valRes.results.bindings[0];
        variables[b.varname.value] = parseFloat(b.val.value);
        argsByOrder.push(b.varname.value);
        continue;
      }
    } else if (types.includes(OM('Application').value)) {
      const nested = await buildExpression(argUri, endpoint);
      Object.assign(variables, nested.variables);
      if (!expressionCache.has(nested.expression)) {
        argsByOrder.push(`(${nested.expression})`);
        expressionCache.add(nested.expression);
      }
      continue;
    }

    throw new Error(`Not known argument type: ${argUri}`);
  }

  const op = operatorToSymbol(operatorUri);
  const expression = isFunctionOperator(op)
    ? `${op}(${argsByOrder.join(', ')})`
    : argsByOrder.join(` ${op} `);

  return { expression, variables };
}

async function getArgumentsViaPathQuery(nodeUri: string, endpoint: string): Promise<Node[]> {
  const query = `
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>
SELECT ?arg WHERE {
  <${nodeUri}> om:arguments ?list .
  ?list rdf:rest*/rdf:first ?arg .
}`;

  const res = await runSelectQuery(query, endpoint);
  return res.results.bindings.map((b: any) => {
    return b.arg.type === 'literal'
      ? { termType: 'Literal', value: b.arg.value } as Literal
      : { termType: 'NamedNode', value: b.arg.value } as NamedNode;
  });
}

const operatorMap: Record<string, string> = {
  'http://www.openmath.org/cd/arith1#plus': '+',
  'http://www.openmath.org/cd/arith1#times': '*',
  'http://www.openmath.org/cd/arith1#divide': '/',
  'http://www.openmath.org/cd/arith1#minus': '-',
  'http://www.openmath.org/cd/arith1#power': '^',
  'http://www.openmath.org/cd/arith1#root': 'nthRoot',
  'http://www.openmath.org/cd/arith1#abs': 'abs',
};

function operatorToSymbol(uri: string): string {
  const op = operatorMap[uri];
  if (!op) throw new Error(`Not supported operator: ${uri}`);
  return op;
}

function isFunctionOperator(op: string): boolean {
  return ['abs', 'nthRoot'].includes(op);
}
