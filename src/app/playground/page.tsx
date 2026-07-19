import { redirect } from 'next/navigation';

// /playground is just an entry point — send it to the dashboard.
export default function PlaygroundIndexPage() {
  redirect('/playground/dashboard');
}
