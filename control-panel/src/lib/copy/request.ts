import {createHash} from 'node:crypto';
export interface IndependentIdentityRequest {
  requestId:string;
  sourceHardware:string;
  destinationHardware:string;
  sourceReceiptSHA256:string;
  manifestSHA256:string;
  clientIds:string[];
}
const hardware=/^smbios:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function independentIdentityRequest(input:IndependentIdentityRequest){
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)||!hardware.test(input.sourceHardware)||!hardware.test(input.destinationHardware)||input.sourceHardware===input.destinationHardware||!/^[a-f0-9]{64}$/.test(input.sourceReceiptSHA256)||!/^[a-f0-9]{64}$/.test(input.manifestSHA256)
    ||!Array.isArray(input.clientIds)||input.clientIds.length>200||input.clientIds.some(id=>!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))||new Set(input.clientIds).size!==input.clientIds.length)throw new Error('Exact independent identity request required');
  const request={...input,clientIds:[...input.clientIds].sort()};
  return {request,fingerprint:createHash('sha256').update(JSON.stringify(request)).digest('hex')};
}

