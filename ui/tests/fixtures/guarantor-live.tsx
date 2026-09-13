import React from 'react';
import {createRoot} from 'react-dom/client';
import {PatientRoute} from '../../src/App';
import {fhir} from '../../src/lib/fhir';
import '../../src/styles/globals.css';
fhir.rehydrateSession();
createRoot(document.getElementById('root')!).render(<PatientRoute patientId={new URLSearchParams(location.search).get('patientId')!} mode="overview"/>);
