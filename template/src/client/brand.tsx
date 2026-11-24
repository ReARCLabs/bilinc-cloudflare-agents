import symbolUrl from "./assets/bilinc-symbol.png";
import cloudflareUrl from "./assets/cloudflare.svg";

export type AgentLine = { kind: "logo"; src: string; alt: string } | { kind: "text"; text: string };

/**
 * The lockup's second line: "a [Cloudflare logo] Agent" (owner's choice, 2026-11-24, after the
 * trademark risk was stated). To drop the logo, change only this constant to
 * `{ kind: "text", text: "for Cloudflare Agents" }`.
 */
export const AGENT_LINE: AgentLine = { kind: "logo", src: cloudflareUrl, alt: "Cloudflare" };

/** Bilinc symbol (44 px) with "Bilinc Memory" (18 px) over the agent line (logo 22 px tall). */
export function Lockup({ as: Title = "div", line = AGENT_LINE }: { as?: "h1" | "div"; line?: AgentLine }) {
  return (
    <div className="lockup">
      <img className="lockup-symbol" src={symbolUrl} alt="Bilinc" width={37} height={44} />
      <div>
        <Title className="lockup-title">Bilinc Memory</Title>
        <div className="lockup-line">
          {line.kind === "logo" ? (
            <>
              a <img src={line.src} alt={line.alt} width={67} height={22} /> Agent
            </>
          ) : (
            line.text
          )}
        </div>
      </div>
    </div>
  );
}
