import { renderToStaticMarkup } from "react-dom/server";
import { Privacy } from "./components/smallbin/Privacy";
import { SiteLayout } from "./components/smallbin/SiteLayout";

// Render once at build time (or dev startup), using the same content and layout
// as in-app navigation. The public information page needs no client runtime.
export async function renderPrivacyPage(template: string, stylesheet?: string): Promise<string> {
  const content = renderToStaticMarkup(<SiteLayout path="/privacy"><Privacy /></SiteLayout>);
  let foundRoot = false;
  const rewriter = new HTMLRewriter()
    .on("#root", { element(element) { foundRoot = true; element.setInnerContent(content, { html: true }); } })
    .on("title", { element(element) { element.setInnerContent("Privacy | Smallbin"); } })
    .on("script, noscript, link[rel='modulepreload']", { element(element) { element.remove(); } });
  if (stylesheet) {
    rewriter.on("head", { element(element) {
      element.append(renderToStaticMarkup(<link rel="stylesheet" href={stylesheet} />), { html: true });
    } });
  }
  const html = await rewriter.transform(new Response(template)).text();
  if (!foundRoot) throw new Error("Privacy page template is missing its content root");
  return html;
}
