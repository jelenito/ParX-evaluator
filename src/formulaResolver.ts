import { runSelectQuery } from './sparqlClient';
import { PARX, VDI3682, OM, RDF, DINEN61360 } from './namespaces';

/**
 * Find formula for given process and output data element
 * @param processUri URI of the process operator
 * @param dataElementUri URI of the output data element
 * @param endpoint URL of the SPARQL endpoint
 * @returns URI of the formula or null
 */
export async function findFormulaForOutput(
  processUri: string,
  dataElementUri: string,
  endpoint: string
): Promise<string | null> {
  const direct = await findFormulaDirect(processUri, dataElementUri, endpoint);
  if (direct) return direct;
  return await findFormulaViaDecomposition(processUri, dataElementUri, endpoint);
}

async function findFormulaDirect(
  processUri: string,
  dataElementUri: string,
  endpoint: string
): Promise<string | null> {
  const q = `
PREFIX ParX: <${PARX('').value}>
PREFIX VDI3682: <${VDI3682('').value}>
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>

SELECT ?formula WHERE {
  <${processUri}> ParX:hasInterdependency ?formula .
  ?formula om:arguments ?args .
  ?args rdf:first ?lhs .
  ?lhs a om:Variable .
  ?de ParX:isDataFor ?lhs .
  FILTER(str(?de) = "${dataElementUri}")
}
LIMIT 1
  `;

  const res = await runSelectQuery(q, endpoint);
  const bindings = res?.results?.bindings;

  if (bindings && bindings.length > 0) {
    return bindings[0].formula.value;
  }

  return null;
}

async function findFormulaViaDecomposition(
  processUri: string,
  dataElementUri: string,
  endpoint: string
): Promise<string | null> {
  const q = `
PREFIX ParX: <${PARX('').value}>
PREFIX VDI3682: <${VDI3682('').value}>
PREFIX DINEN61360: <${DINEN61360('').value}>
PREFIX om: <${OM('').value}>
PREFIX rdf: <${RDF('').value}>

SELECT ?formula WHERE {
  ?state DINEN61360:has_Data_Element <${dataElementUri}> .
  <${processUri}> VDI3682:consistsOf+ ?sub .
  ?sub VDI3682:hasOutput ?state .
  ?sub ParX:hasInterdependency ?formula .
  ?formula om:arguments ?args .
  ?args rdf:first ?lhs .
  ?lhs a om:Variable .
  ?de ParX:isDataFor ?lhs .
  FILTER(str(?de) = "${dataElementUri}")
}
LIMIT 1
  `;

  const res = await runSelectQuery(q, endpoint);
  const bindings = res?.results?.bindings;

  if (bindings && bindings.length > 0) {
    return bindings[0].formula.value;
  }

  return null;
}
