import axios from 'axios';

/**
 * Executes a SPARQL SELECT query against a specified endpoint.
 * @param query 
 * @param endpoint URL of the SPARQL endpoint
 * @returns JSON result of the query
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
  
