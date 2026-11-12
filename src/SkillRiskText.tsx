import { highlightSkillRiskText } from "./shared/security-highlights";

export default function SkillRiskText({ text }: { text: string }) {
  return <>{highlightSkillRiskText(text).map((part, index) => part.kind
    ? <mark className={`skill-evidence-highlight ${part.kind}`} key={index}>{part.text}</mark>
    : part.text)}</>;
}
