import { redirect } from 'next/navigation';

// /playground is just an entry point — send it to the first tab.
export default function PlaygroundIndexPage() {
  redirect('/playground/path-generation');
}
