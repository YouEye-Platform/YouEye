import {NextRequest,NextResponse} from 'next/server';
import {getSession} from '@/lib/auth';
import {inspectInstalledCopyInventory} from '@/lib/copy/installed-inventory';

import {CopyInventoryError} from '@/lib/copy/inventory';
import {prepareIndependentPlatform,type CopyPlatformStep} from '@/lib/copy/platform';

export const dynamic='force-dynamic';
/** Private native inventory endpoint. Inventory availability alone is not an
 * advertised operational copy capability; the host coordinator owns that gate. */
export async function GET(){
 const session=await getSession();
 if(!session?.isAdmin||session.authMethod!=='cli')return NextResponse.json({error:'Native copy authority required'},{status:403});
 try{return NextResponse.json(await inspectInstalledCopyInventory(),{headers:{'Cache-Control':'no-store'}});}
 catch(error){return NextResponse.json({error:error instanceof CopyInventoryError?error.message:'Installed copy inventory requires native reconciliation'},{status:409});}
}

export async function POST(request:NextRequest){
 const session=await getSession();
 if(!session?.isAdmin||session.authMethod!=='cli')return NextResponse.json({error:'Native copy authority required'},{status:403});
 try{
  const text=await request.text();if(Buffer.byteLength(text)>2*1024*1024)throw Error('Copy request too large');
  const body=JSON.parse(text);
  if(!['identity','domain','apps','verify'].includes(body.step))return NextResponse.json({error:'Exact native copy step required'},{status:400});
  return NextResponse.json(await prepareIndependentPlatform(body.request,body.inventory,body.namesBundle,body.step as CopyPlatformStep),{headers:{'Cache-Control':'no-store'}});
 }catch{
  // Requests contain a protected Names bundle. Never echo the body, SQL,
  // transport response, configuration or private journal in diagnostics.
  return NextResponse.json({error:'Native copy platform step requires reconciliation; quarantine remains required'},{status:409});
 }
}
