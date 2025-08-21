import axios from 'axios';

/**
 * Executes a SPARQL SELECT query
 * @param query The SPARQL query to execute
 * @param endpoint URL of the SPARQL endpoint
 * @returns JSON response with query results
 */
export async function runSelectQuery(query: string, endpoint: string): Promise<any> {
  try {
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
    console.error('SPARQL query failed:\n', query);
    const status = error.response?.status;
    throw new Error(`SPARQL request failed (${status}): ${query}`);
  }
}
  
