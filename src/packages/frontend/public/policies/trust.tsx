import {
  A,
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
  description: "Security, GDPR, SOC 2, and external trust resources.",
  navLabel: "Trust",
  slug: "trust",
  title: "Trust and Compliance",
  content: (
    <>
      <PolicySection title="GDPR">
        <p>
          SageMath, Inc. compliance with{" "}
          <A href={"https://gdpr-info.eu/"}>GDPR</A> has been verified by
          our EU and UK representative{" "}
          <A href={"https://gdprlocal.com/"}>GDPR Local</A>.
        </p>
        <p>
          <iframe
            srcDoc={GDPR_BADGE_HTML}
            sandbox="allow-scripts"
            style={{
              width: "100%",
              height: "180px",
              border: "none",
              overflow: "auto",
            }}
          />
        </p>
      </PolicySection>
      <PolicySection title="SOC 2">
        <div
          style={{
            alignItems: "start",
            display: "grid",
            gap: "1em",
            gridTemplateColumns: "minmax(0, 1fr) auto",
          }}
        >
          <div>
            <p>
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
                <A href="https://trust.cocalc.com/">
                  Sagemath, Inc.'s Trust Center
                </A>
                .
              </strong>
            </p>
          </div>
          <img
            style={{ maxWidth: "100%", width: "150px" }}
            src={policyHref(SOC2LOGO)}
            alt={"SOC 2 Compliance Logo"}
          />
        </div>
      </PolicySection>
      <PolicySection title="Questions?">
        <p>
          Please contact us at{" "}
          <A href="mailto:office@sagemath.com">office@sagemath.com</A> if
          you have any questions.
        </p>
      </PolicySection>
    </>
  ),
};

export default trustPolicy;
