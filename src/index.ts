import { findFormulaForOutput } from './formulaResolver';
import { evaluateFormula, checkRestrictions } from './evaluator';

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

  // Smart endpoint detection: if repo looks like URL, use it directly, otherwise construct localhost URL
  const endpoint = repo.startsWith('http://') || repo.startsWith('https://') 
    ? repo 
    : `http://localhost:7200/repositories/${repo}`;
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

    // Check restrictions
    const { warnings, checkedCount } = await checkRestrictions(outputDataElement, result.result, endpoint);
    if (warnings.length > 0) {
      console.log(`\n⚠️  Restriction Warnings (checked ${checkedCount}):`);
      for (const w of warnings) {
        console.log(`   - ${w.message}`);
      }
    } else {
      console.log(`✓ No restriction violations. Checked ${checkedCount} restrictions.`);
    }
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
