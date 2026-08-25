import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GET } from "../src/app/health/route";
import RootLayout from "../src/app/layout";
import Home from "../src/app/page";

describe("app scaffold", () => {
  it("renders the credential-free bootstrap page", () => {
    const markup = renderToStaticMarkup(<Home />);

    expect(markup).toContain("Milestone 1 bootstrap is running");
    expect(markup).toContain("integrations remain unavailable");
  });

  it("renders the root document language and child content", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <p>child</p>
      </RootLayout>
    );

    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain("<p>child</p>");
  });

  it("reports healthy with optional integrations unavailable", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      integrations: {
        google: "unavailable",
        openai: "unavailable"
      },
      service: "app",
      status: "ok"
    });
  });
});
