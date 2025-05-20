import { runSelectQuery } from './sparqlClient';
import { OM, PARX, DINEN61360, RDF } from './namespaces';
import { evaluate } from 'mathjs';

/**
 * Evaluiert rekursiv eine om:Application per SPARQL.
 * @param formulaUri URI der  Interdependency Formel
 * @param endpoint GraphDB-Endpunkt
 * @returns Ergebniswert und ausgewerteter Ausdruck
 */
export async function evaluateFormula(formulaUri: string, endpoint: string): Promise<{ expression: string, result: number }> {
  const { expression, variables } = await buildExpression(formulaUri, endpoint);

  // Ersetze Variablennamen durch ihre konkreten Werte
  const exprWithValues = expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, name => {
    if (variables[name] !== undefined) return variables[name].toString();
    throw new Error(`Fehlender Wert für Variable: ${name}`);
  });

  const result = evaluate(exprWithValues);

  return {
    expression: exprWithValues,
    result
  };
}

/**
 * Rekonstruiert rekursiv den math.js-Ausdruck und sammelt Variablenwerte.
 */
async function buildExpression(nodeUri: string, endpoint: string): Promise<{ expression: string, variables: Record<string, number> }> {
  const operatorQuery = `
PREFIX om: <${OM('').value}>
SELECT ?op WHERE { <${nodeUri}> om:operator ?op } LIMIT 1
  `;
  const opResult = await runSelectQuery(operatorQuery, endpoint);
  const operatorUri = opResult.results.bindings[0].op.value;

  // Sonderfall: Gleichung
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

  // Argumente geordnet abfragen ohne Blank Node Referenz
  const argUris = await getArgumentsViaPathQuery(nodeUri, endpoint);
  const variables: Record<string, number> = {};
  const argsByOrder: string[] = [];
  const expressionCache = new Set<string>();

  for (const arg of argUris) {
    if (/^\".+\"\^\^xsd:double$/.test(arg)) {
      const match = arg.match(/^\"(.+)\"\^\^xsd:double$/);
      if (match) {
        argsByOrder.push(match[1]);
        continue;
      }
    }

    const typeQuery = `
PREFIX om: <${OM('').value}>
SELECT ?type WHERE { <${arg}> a ?type }`;
    const typeRes = await runSelectQuery(typeQuery, endpoint);
    const types = typeRes.results.bindings.map((b: any) => b.type.value);

    if (types.includes(OM('Variable').value) && !types.includes(OM('Application').value)) {
      const valueQuery = `
PREFIX parx: <${PARX('').value}>
PREFIX din: <${DINEN61360('').value}>
PREFIX om: <${OM('').value}>

SELECT ?val ?varname WHERE {
  <${arg}> a om:Variable .
  BIND(REPLACE(STR(<${arg}>), ".*[#/](.+)$", "$1") AS ?varname)
  ?de parx:isDataFor <${arg}> ;
      din:hasInstanceDescription ?desc .
  ?desc din:value ?val .
} LIMIT 1`;

      const valRes = await runSelectQuery(valueQuery, endpoint);
      if (valRes.results.bindings.length > 0) {
        const b: any = valRes.results.bindings[0];
        variables[b.varname.value] = parseFloat(b.val.value);
        argsByOrder.push(b.varname.value);
        continue;
      }
    } else if (types.includes(OM('Application').value)) {
      const nested = await buildExpression(arg, endpoint);
      Object.assign(variables, nested.variables);
      if (!expressionCache.has(nested.expression)) {
        argsByOrder.push(`(${nested.expression})`);
        expressionCache.add(nested.expression);
      }
      continue;
    }

    throw new Error(`Unbekannter Argumenttyp für: ${arg}`);
  }

  const op = operatorToSymbol(operatorUri);
  const expression = isFunctionOperator(op)
    ? `${op}(${argsByOrder.join(', ')})`
    : argsByOrder.join(` ${op} `);

  return { expression, variables };
}

/**
 * Holt Argumente einer RDF-Liste über rdf:rest* /rdf:first in Reihenfolge
 */
async function getArgumentsViaPathQuery(nodeUri: string, endpoint: string): Promise<string[]> {
  const query = `
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>
SELECT ?arg WHERE {
  <${nodeUri}> om:arguments ?list .
  ?list rdf:rest*/rdf:first ?arg .
}`;

  const res = await runSelectQuery(query, endpoint);
  return res.results.bindings.map((b: any) => b.arg.value);
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
  if (!op) throw new Error(`Nicht unterstützter Operator: ${uri}`);
  return op;
}

function isFunctionOperator(op: string): boolean {
  return ['abs', 'nthRoot'].includes(op);
}
