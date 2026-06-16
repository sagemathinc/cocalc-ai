import { Col, Row } from "antd";

import {
  A,
  COCALC_TRUST_CENTER_URL,
  policyHref,
  PolicySection,
  type PublicPolicy,
} from "./policy";

const SOC2LOGO = "/public/soc2-aicpa-logo.png";

const GDPR_BADGE_HTML = `
<html>
  <head>
    <style>
      .verificationBadgeContainer {
        display: inline-block;
        text-align: left;
      }
    </style>
  </head>
  <body>
    <div id="gdprVerifier"></div>
    <script>
      (function(w,d,s,o,f,js,fjs){
        w[o]=w[o]||function(){(w[o].q=w[o].q||[]).push(arguments)};
        js=d.createElement(s),fjs=d.getElementsByTagName(s)[0];
        js.id=o;js.src=f;js.async=1;fjs.parentNode.insertBefore(js,fjs);
      }(window,document,'script','gdprBadge','https://cdn.gdprlocal.com/static/widget.js'));

      gdprBadge('init', {
        element: document.getElementById('gdprVerifier'),
        verificationId: 'RNCB5WV'
      });
    </script>
  </body>
</html>
`;

export const trustPolicy: PublicPolicy = {
  description:
    "Published trust resources, including SOC 2, GDPR, and Trust Center references.",
  navLabel: "Trust",
  slug: "trust",
  title: "Trust and Compliance",
  updated: "June 9, 2026",
  content: (
    <>
      <PolicySection title="SOC 2">
        <Row align="top" gutter={["middle", "middle"]}>
          <Col sm={16} xs={24}>
            <p style={{ marginTop: 0 }}>
              CoCalc by SageMath, Inc. is{" "}
              <strong>
                <A href="https://www.vanta.com/collection/soc-2/what-is-soc-2">
                  SOC 2 compliant
                </A>
              </strong>
              , meaning we meet rigorous standards for data security and
              operational integrity. This compliance is verified through
              independent audits, ensuring that we effectively protect customer
              information across security, availability, processing integrity,
              confidentiality, and privacy. Our commitment to these high
              standards enhances trust and reliability for our users.
            </p>
            <p>
              <strong>
                Please learn more about the current status in{" "}
                <A href={COCALC_TRUST_CENTER_URL}>
                  SageMath, Inc.'s Trust Center
                </A>
                .
              </strong>
            </p>
          </Col>
          <Col sm={8} xs={24}>
            <div style={{ textAlign: "center" }}>
              <img
                style={{ maxWidth: "100%", width: "150px" }}
                src={policyHref(SOC2LOGO)}
                alt={"SOC 2 Compliance Logo"}
              />
            </div>
          </Col>
        </Row>
      </PolicySection>
      <PolicySection title="GDPR">
        <Row align="top" gutter={["middle", "middle"]}>
          <Col sm={16} xs={24}>
            <p style={{ marginTop: 0 }}>
              SageMath, Inc. compliance with{" "}
              <A href={"https://gdpr-info.eu/"}>GDPR</A> has been verified by
              our EU and UK representative{" "}
              <A href={"https://gdprlocal.com/"}>GDPR Local</A>.
            </p>
          </Col>
          <Col sm={8} xs={24}>
            <div style={{ textAlign: "center" }}>
              <iframe
                srcDoc={GDPR_BADGE_HTML}
                sandbox="allow-scripts"
                style={{
                  border: "none",
                  height: "180px",
                  maxWidth: "100%",
                  overflow: "auto",
                  width: "180px",
                }}
              />
            </div>
          </Col>
        </Row>
      </PolicySection>
      <PolicySection title="Questions?">
        <p>
          Please contact us at{" "}
          <A href="mailto:office@sagemath.com">office@sagemath.com</A> if you
          have any questions.
        </p>
      </PolicySection>
    </>
  ),
};

export default trustPolicy;
