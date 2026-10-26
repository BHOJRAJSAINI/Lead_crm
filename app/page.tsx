import { redirect } from 'next/navigation';

/** Serves the 1:1 UI shell (public/crm/index.html + public/gas-shim.js). */
export default function Home() {
  redirect('/crm/index.html');
}
