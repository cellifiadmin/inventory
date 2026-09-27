import { expect, it, jest } from '@jest/globals';
import { captureSaleIdentity, validateReturnedIdentity } from '@/inventory/services/saleIdentityService';
it('freezes actual serialized component identifiers or an explicit bulk identity at sale time', async () => {
 const findMany=jest.fn<any>().mockResolvedValue([{instance:{identifier:'serial-B'}},{instance:null},{instance:{identifier:'serial-A'}}]);
 expect(await captureSaleIdentity({component:{findMany}} as any,7,1)).toEqual({version:1,identifiers:['serial-A','serial-B']});
 expect(findMany).toHaveBeenCalledWith({where:{itemId:7},select:{instance:{select:{identifier:true}}}});
 await expect(captureSaleIdentity({component:{findMany}} as any,7,2)).rejects.toThrow('SERIALIZED_SALE_QUANTITY_INVALID');
 findMany.mockResolvedValue([{instance:null}]);expect(await captureSaleIdentity({component:{findMany}} as any,7,4)).toEqual({version:1,identifiers:[]});
});
it('requires retained sale evidence and exact inspected identities without substituting current item identity',()=>{
 expect(validateReturnedIdentity([{version:1,identifiers:['serial-B','serial-A']}],['serial-A','serial-B'])).toBeUndefined();
 expect(validateReturnedIdentity([{version:1,identifiers:[]}],[])).toBeUndefined();
 for(const evidence of [null,{}, {version:2,identifiers:[]},{version:1,identifiers:[1]}])
 expect(()=>validateReturnedIdentity([evidence],[])).toThrow('RETURN_RESTOCK_SALE_EVIDENCE_MISSING');
 for(const identifiers of [[],['other'],['serial-A','serial-A']])
 expect(()=>validateReturnedIdentity([{version:1,identifiers:['serial-A']}],identifiers)).toThrow('RETURN_RESTOCK_IDENTITY_MISMATCH');
});
