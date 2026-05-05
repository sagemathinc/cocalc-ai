/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import AccessibilityContent from "./accessibility-content";
import { Customize, Footer, Head, Header, Layout, MAX_WIDTH } from "./compat";

export default function AccessibilityPage() {
  return (
    <Customize>
      <Head title="Accessibility" />
      <Layout>
        <Header page="policies" subPage="accessibility" />
        <Layout.Content
          style={{
            backgroundColor: "white",
          }}
        >
          <div
            style={{
              maxWidth: MAX_WIDTH,
              margin: "15px auto",
              padding: "15px",
              backgroundColor: "white",
            }}
          >
            <div style={{ textAlign: "center", color: "#444" }}>
              <h1 style={{ fontSize: "28pt" }}>
                CoCalc Voluntary Product Accessibility Template (VPAT)
              </h1>
              <h2>Last Updated: July 3, 2019</h2>
            </div>
            <div style={{ fontSize: "12pt", overflowX: "auto" }}>
              <AccessibilityContent />
            </div>
          </div>
          <Footer />
        </Layout.Content>
      </Layout>
    </Customize>
  );
}
