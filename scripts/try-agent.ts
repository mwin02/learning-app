// Throwaway driver for the curriculum agent. Not wired into any route.
// Edit `input` below and run: `npx tsx --env-file=.env.local scripts/try-agent.ts`
// Prints the full agent output as JSON, then exits.

import { generateCurriculum } from "@/lib/curriculum-agent";

const input = {
  topic: "python-data-ml",
  difficulty: "beginner" as const,
  priorKnowledge: "have JavaScript experience but new to Python and ML",
  timeframeWeeks: 6,
  hoursPerWeek: 5,
};

async function main() {
  console.log("Input:", JSON.stringify(input, null, 2));
  const result = await generateCurriculum(input);
  console.log("\nResult:");
  console.log(JSON.stringify(result, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
