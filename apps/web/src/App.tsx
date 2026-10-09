import { Library, Studio, useStudio } from "@cueprint/ui";

export function App() {
  const hasSet = useStudio((s) => !!s.current);
  return hasSet ? <Studio /> : <Library />;
}
