// Notebook UI (Block A): the hand-drawn logo — a tilted inked circle with the
// brand initial — plus the wordmark in handwriting. Used in every sheet header.

import Link from 'next/link';
import { BRAND } from '@/lib/brand';

export function NotebookBrand({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-[9px] no-underline">
      <div className="flex h-[34px] w-[34px] -rotate-6 items-center justify-center rounded-[50%_50%_50%_6px] border-[2.5px] border-pen">
        <span className="font-hand text-[22px] font-bold text-pen">{BRAND.charAt(0)}</span>
      </div>
      <span className="font-hand text-[28px] font-bold text-script">{BRAND}</span>
    </Link>
  );
}
