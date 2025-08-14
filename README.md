# ParX-evaluator

**ParX-evaluator** is a Node.js/TypeScript framework for evaluating process parameter interdependencies in manufacturing knowledge graphs.  
It uses **SPARQL** to traverse semantic models based on industrial standards according to the **ParX ontology** and **mathjs** for symbolic/numeric computation, enabling automated resolution of mathematical expressions modeled in **OpenMath-RDF**.


## Usage
The evaluator connects to a SPARQL endpoint containing your manufacturing process knowledge graph, retrieves relevant mathematical expressions, resolves input parameters, and calculates results.

### Start evaluation
Run directly with ts-node:
```bash
npx ts-node src/index.ts {$graphRepo} {$processURI} {$parameterURI}
```
- **`$graphRepo`** – URL or file path of the knowledge graph repository (SPARQL endpoint).
- **`$processURI`** – IRI of the process operator in the knowledge graph.
- **`$parameterURI`** – IRI of the parameter to be evaluated.

This will:
1. Retrieve the formula for the specified parameter.
2. Traverse the `OpenMath-RDF` expression tree.
3. Bind data elements and retrieve values.
4. (In case of missing values) Recursively resolve any missing values from upstream processes.
5. Compute and return the result.

## Requirements
- Node.js (>= 16)
- A running SPARQL endpoint with a process model in RDF/OWL format
- Knowledge graph modeled according to existing industrial standard ontology design patterns (see https://github.com/hsu-aut/parx):
  - **VDI/VDE 3682** – process modeling according to the formalized process description (fpd)
  - **DIN EN 61360** – parameter characteristics
  - **OpenMath-RDF** – mathematical expressions
