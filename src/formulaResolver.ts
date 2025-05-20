import { runSelectQuery } from './sparqlClient';
import { PARX, VDI3682, OM } from './namespaces';

/**
 * Findet die URI einer Formel (om:Application), die im angegebenen Prozess das angegebene Ziel-DataElement beschreibt.
 * @param processUri URI des vdi3682:ProcessOperator
 * @param dataElementUri URI des dinen:DataElement (gewünschtes Ergebnis)
 * @param endpoint GraphDB-Endpunkt
 * @returns URI der Formel (als string), oder null wenn nicht gefunden
 */
export async function findFormulaForOutput(
  processUri: string,
  dataElementUri: string,
  endpoint: string
): Promise<string | null> {
  const query = `
PREFIX parx: <${PARX('').value}>
PREFIX vdi: <${VDI3682('').value}>
PREFIX om: <${OM('').value}>

SELECT ?formula WHERE {
  <${processUri}> parx:hasInterdependency ?formula .
  ?formula om:arguments ?argList .
  ?argList rdf:first ?lhs .
  ?lhs a om:Variable .
  ?de parx:isDataFor ?lhs .
  FILTER(str(?de) = "${dataElementUri}")
}
LIMIT 1
  `;

  const data = await runSelectQuery(query, endpoint);
  const bindings = data?.results?.bindings;

  if (bindings.length > 0) {
    return bindings[0].formula.value;
  }

  return null;
}
