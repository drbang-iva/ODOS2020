import React from 'react';
import {createRoot} from 'react-dom/client';
import {PatientInsurance} from '../../src/scenes/insurance/PatientInsurance';
import {fhir} from '../../src/lib/fhir';
import '../../src/styles/globals.css';
fhir.rehydrateSession();
createRoot(document.getElementById('root')!).render(<PatientInsurance initialPatientId={new URLSearchParams(location.search).get('patientId')!}/>);
