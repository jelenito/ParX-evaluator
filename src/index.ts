import { findFormulaForOutput } from './formulaResolver';
import { evaluateFormula } from './evaluator';

//const endpoint = 'http://localhost:7200/repositories/TEST0525'; 
//const processUri = 'http://www.hsu-hh.de/aut/ontologies/example#Injection'; 
//const outputDataElement = 'http://www.hsu-hh.de/aut/ontologies/example#FillTime_DE'; 

async function main() {
  const [,, repo, processUri, outputDataElement] = process.argv;

  if (!repo || !processUri || !outputDataElement) {
    console.error(` Missing arguments!

Usage:
  npx ts-node src/index.ts <REPOSITORY_NAME> <PROCESS_URI> <DATA_ELEMENT_URI>

Example:
  npx ts-node src/index.ts TestRepoName http://example.org#MyProcess http://example.org#Output_DE
`);
    process.exit(1);
  }

  const endpoint = `http://localhost:7200/repositories/${repo}`;
  try {

 
     
    console.log('Searching Interdependency formula...');
    const formulaUri = await findFormulaForOutput(processUri, outputDataElement, endpoint);

    if (!formulaUri) {
      console.error(' No formula found for the given process and data element.');
      return;
    }

    console.log('Interdependency formula found:', formulaUri);

    const result = await evaluateFormula(formulaUri, endpoint);

    console.log('Evaluated Expression:', result.expression);
    console.log('Calculation-Result:', result.result);
  } catch (e) {
    console.error(' Error:', e);
  }
  console.log(`
    ██████╗   ██╗  ██╗
    ██╔══██╗  ╚██╗██╔╝
    ██████╔╝   ╚███╔╝ - Evaluator
    ██╔═══╝    ██╔██╗ 
    ██║       ██╔╝ ██╗
    ╚═╝   ar  ╚═╝  ╚═╝
  
  `);
}

main();
