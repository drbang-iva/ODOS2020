import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RouteSwitch} from '../../src/App';
import {GuarantorLinkScreens} from '../../src/components/patient/GuarantorLinkScreens';
import {fhir} from '../../src/lib/fhir';
import '../../src/styles/globals.css';
fhir.rehydrateSession();
function Fixture(){const params=new URLSearchParams(location.search);const [actions,setActions]=useState<string[]>();useEffect(()=>{void fetch('/desk/whoami',{headers:{Authorization:fhir.authHeader()!}}).then(r=>r.json()).then(body=>setActions(body.businessActions));},[]);if(!actions)return <p>Loading permissions…</p>;return params.has('settings')?<RouteSwitch view={{} as never} path={params.get('settings')!} search="" roles={['staff']} businessActions={actions}/>:<main style={{maxWidth:900,margin:'32px auto',padding:24}}><h1>Synthetic patient — guarantor</h1><GuarantorLinkScreens relatedPersonId={params.get('child')!} disabled={!actions.includes('guarantor.link')} attachOnly onReload={async()=>{}}/></main>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
