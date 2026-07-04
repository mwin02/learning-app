'use client';

// Notebook component gallery (Block B): renders every Block-B component with
// mock data so the design language can be reviewed before the wired pages
// exist. The bookmark rail is stateful here to demo the accordion behavior.

import { useState } from 'react';
import { Desk, Sheet } from '@/components/notebook/Sheet';
import { NotebookBrand } from '@/components/notebook/NotebookBrand';
import { accentFor } from '@/components/notebook/accents';
import { IndexCard } from '@/components/notebook/primitives';
import { ContinueCard } from '@/components/notebook/ContinueCard';
import { TocEntry } from '@/components/notebook/TocEntry';
import { BookmarkRail, BookmarkTab, type TabLesson } from '@/components/notebook/BookmarkTab';
import { SectionRow } from '@/components/notebook/SectionRow';

const PROGRAMS = [
  { chapter: 'I', title: 'ML engineering from scratch', meta: 'Goal-driven program · 4 courses', nextUp: 'Interactive: transformations', done: 5, total: 45, edge: '2/4 built' },
  { chapter: 'II', title: 'Calculus before grad school', meta: 'Goal-driven program · 2 courses', nextUp: 'Limits — a first look', done: 9, total: 24, edge: 'ready' },
  { chapter: 'III', title: 'Frontend fundamentals', meta: 'Goal-driven program · 3 courses', done: 30, total: 30, edge: 'ready' },
];

const COURSES: { short: string; fraction: string; lessons: TabLesson[] }[] = [
  { short: 'Linear Algebra', fraction: '4/4', lessons: [
    { title: 'What is a vector?', state: 'done' },
    { title: 'Vector addition & scaling', state: 'done' },
    { title: 'Practice: vector arithmetic', state: 'done' },
    { title: 'Notes: vector spaces', state: 'done' },
  ]},
  { short: 'Python for Data', fraction: '1/4', lessons: [
    { title: 'Matrix multiplication', state: 'done' },
    { title: 'Interactive: transformations', state: 'current' },
    { title: 'Compute determinants', state: 'todo' },
    { title: '3Blue1Brown — transforms', state: 'todo' },
  ]},
  { short: 'Statistics', fraction: '0/3', lessons: [
    { title: 'Intro to eigenvalues', state: 'todo' },
    { title: 'Eigenvector problem set', state: 'todo' },
    { title: 'Further reading', state: 'todo' },
  ]},
];

const SECTIONS = [
  { title: 'Vectors & Vector Spaces', meta: '4 lessons · ~2h', done: 4, total: 4 },
  { title: 'Matrices & Transformations', meta: '4 lessons · ~2h 10m', done: 1, total: 4 },
  { title: 'Eigenvalues & Eigenvectors', meta: '3 lessons · ~1h 50m', done: 0, total: 3 },
];

function GalleryHeading({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 mt-9 font-hand text-3xl font-bold text-script">{children}</div>;
}

export function PreviewGallery() {
  const [active, setActive] = useState(1);

  return (
    <Desk maxWidth={1120}>
      <BookmarkRail>
        <BookmarkTab kicker="Program" label="Overview" meta="ML engineering" bg="#4a5a6a" active={active === -1} onClick={() => setActive(-1)} />
        {COURSES.map((c, i) => (
          <BookmarkTab
            key={c.short}
            kicker={`Course ${i + 1} · ${c.fraction}`}
            label={c.short}
            bg={accentFor(i).bg}
            active={active === i}
            onClick={() => setActive(i)}
            lessons={c.lessons}
          />
        ))}
      </BookmarkRail>

      <Sheet>
        <div className="mb-4 flex h-[60px] items-end justify-between">
          <NotebookBrand />
          <span className="font-script text-sm text-script-faint">component gallery · mock data</span>
        </div>

        <GalleryHeading>Dashboard — table of contents</GalleryHeading>
        {PROGRAMS.map((p, i) => (
          <TocEntry key={p.chapter} {...p} accent={accentFor(i)} href="#" />
        ))}

        <GalleryHeading>Continue sticky note</GalleryHeading>
        <ContinueCard
          title="Interactive: transformations"
          meta="Section 2 · Lesson 2 · embed · ~12 min"
          href="#"
        />

        <GalleryHeading>Up-next index card</GalleryHeading>
        <IndexCard
          accent="var(--color-nb-violet)"
          kicker="up next · exercise"
          title="Compute determinants — 5 problems"
          meta="~15 min"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
          }
        />

        <GalleryHeading>Course content — section rows</GalleryHeading>
        {SECTIONS.map((s, i) => (
          <SectionRow key={s.title} n={i + 1} accent={accentFor(i)} {...s} />
        ))}
      </Sheet>
    </Desk>
  );
}
