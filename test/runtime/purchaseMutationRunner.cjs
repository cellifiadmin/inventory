const assert=require('node:assert/strict');
function classifyMutationResult(report,status){
 assert.ok(report&&report.numTotalTests>0&&report.numPendingTests===0&&report.numTodoTests===0,'Incomplete mutation test execution');
 const assertions=report.testResults.flatMap(suite=>suite.assertionResults);
 assert.equal(assertions.length,report.numTotalTests);
 assert.equal(assertions.filter(row=>row.status==='failed').length,report.numFailedTests);
 assert.equal(assertions.filter(row=>row.status==='passed').length,report.numPassedTests);
 assert.equal(report.numFailedTests+report.numPassedTests,report.numTotalTests);
 if(status===0){assert.equal(report.numFailedTests,0);return 'Survived';}
 assert.equal(status,1);assert.ok(report.numFailedTests>0,'Runner or compilation failure is not a killed mutant');return 'Killed';
}
function replaceOnce(source,from,to){assert.equal(source.split(from).length,2,'Mutation anchor must occur exactly once');return source.replace(from,to);}
module.exports={classifyMutationResult,replaceOnce};
