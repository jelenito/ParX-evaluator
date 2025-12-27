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

/**
 * Executes a SPARQL CONSTRUCT query and returns Turtle
 * @param query The SPARQL CONSTRUCT query
 * @param endpoint URL of the SPARQL endpoint
 * @returns Turtle string
 */
export async function runConstructQuery(query: string, endpoint: string): Promise<string> {
  try {
    const response = await axios.post(
      endpoint,
      `query=${encodeURIComponent(query)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/turtle'
        }
      }
    );
    return response.data;
  } catch (error: any) {
    console.error('SPARQL CONSTRUCT failed:\n', query);
    const status = error.response?.status;
    throw new Error(`SPARQL CONSTRUCT failed (${status}): ${query}`);
  }
}
  
