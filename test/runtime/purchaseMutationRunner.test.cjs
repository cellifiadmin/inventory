const {test}=require('node:test');const assert=require('node:assert/strict');
const {classifyMutationResult,replaceOnce}=require('./purchaseMutationRunner.cjs');
const report=status=>({numTotalTests:1,numPassedTests:status==='passed'?1:0,numFailedTests:status==='failed'?1:0,numPendingTests:0,numTodoTests:0,testResults:[{assertionResults:[{status}]}]});
test('only executed assertion failures kill mutants',()=>{assert.equal(classifyMutationResult(report('failed'),1),'Killed');assert.equal(classifyMutationResult(report('passed'),0),'Survived');for(const data of [null,{...report('failed'),numTotalTests:0},{...report('failed'),numFailedTests:0},{...report('passed'),numPendingTests:1}])assert.throws(()=>classifyMutationResult(data,1));});
test('runner failures and inconsistent outcomes cannot count as killed',()=>{assert.throws(()=>classifyMutationResult(report('failed'),0));assert.throws(()=>classifyMutationResult(report('passed'),1));});
test('mutation anchors must occur exactly once',()=>{assert.equal(replaceOnce('a guard z','guard','false'),'a false z');assert.throws(()=>replaceOnce('a','guard','x'));assert.throws(()=>replaceOnce('guard guard','guard','x'));});
