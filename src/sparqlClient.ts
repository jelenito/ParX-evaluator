import axios from 'axios';

/**
 * Führt eine SPARQL-SELECT-Query gegen einen GraphDB-Endpunkt aus
 * @param query SPARQL-Query als string
 * @param endpoint URL des GraphDB-Endpunkts (z. B. http://localhost:7200/repositories/{repositoryName})
 * @returns JSON-Ergebnis der Query
 */
export async function runSelectQuery(query: string, endpoint: string): Promise<any> {
  
   try{
    const response = await axios.post(
      endpoint,
      `query=${encodeURIComponent(query)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json'
        }
      }
    );
  
    return response.data;
   } catch (error: any) {
    console.error('Failed SPARQL query:\n', query);
    const status = error.response?.status;
    throw new Error(`SPARQL request to ${endpoint} failed with status ${status}. Query: ${query}`);
  }
}
  
