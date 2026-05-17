import { A, PolicySection, type PublicPolicy } from "./policy";

export const copyrightPolicy: PublicPolicy = {
  description:
    "How SageMath, Inc. handles copyright complaints and DMCA notices.",
  navLabel: "Copyright",
  slug: "copyright",
  title: "Copyright Policy",
  updated: "March 27, 2026",
  content: (
    <>
      <PolicySection title='Notification of Copyright Infringement'>
        <p>
          SageMath, Inc. ("SageMath") respects the intellectual property
          rights of others and expects its users to do the same.{" "}
        </p>
        <p>
          It is SageMath's policy, in appropriate circumstances and at its
          discretion, to disable and/or terminate the accounts of users
          who repeatedly infringe the copyrights of others.{" "}
        </p>
        <p>
          In accordance with the Digital Millennium Copyright Act of 1998,
          the text of which may be found on the U.S. Copyright Office
          website at{" "}
          <A href="https://www.copyright.gov/legislation/dmca.pdf">
            https://www.copyright.gov/legislation/dmca.pdf
          </A>
          , SageMath will respond expeditiously to claims of copyright
          infringement committed using the SageMath website(s) (the
          "Sites") that are reported to SageMath's Designated Copyright
          Agent, identified in the sample notice below.{" "}
        </p>
        <p>
          If you are a copyright owner, or are authorized to act on behalf
          of one, or authorized to act under any exclusive right under
          copyright, please report alleged copyright infringements taking
          place on or through the Sites by completing the following DMCA
          Notice of Alleged Infringement and delivering it to SageMath's
          Designated Copyright Agent. Upon receipt of the Notice as
          described below, SageMath will take whatever action, in its sole
          discretion, it deems appropriate, including removal of the
          challenged material from the Sites.{" "}
        </p>
      </PolicySection>
      <PolicySection title='DMCA Notice of Alleged Infringement ("Notice")'>
        <p></p>
        <ol>
          <li>
            Identify the copyrighted work that you claim has been
            infringed, or--if multiple copyrighted works are covered by
            this Notice--you may provide a representative list of the
            copyrighted works that you claim have been infringed.
          </li>
          <li>
            Identify the material that you claim is infringing (or to be
            the subject of infringing activity) and that is to be removed
            or access to which is to be disabled, and information
            reasonably sufficient to permit us to locate the material,
            including at a minimum, if applicable, the URL of the link
            shown on the Site(s) where such material may be found.
          </li>
          <li>
            Provide your mailing address, telephone number, and, if
            available, email address.{" "}
          </li>
          <li>
            Include both of the following statements in the body of the
            Notice:
            <ul>
              <li>
                "I hereby state that I have a good faith belief that the
                disputed use of the copyrighted material is not authorized
                by the copyright owner, its agent, or the law (e.g., as a
                fair use)."
              </li>
              <li>
                "I hereby state that the information in this Notice is
                accurate and, under penalty of perjury, that I am the
                owner, or authorized to act on behalf of the owner, of the
                copyright or of an exclusive right under the copyright
                that is allegedly infringed."
              </li>
            </ul>
          </li>
          <li>
            Provide your full legal name and your electronic or physical
            signature.{" "}
          </li>
        </ol>
        <p>
          Deliver this Notice, with all items completed, to SageMath,
          Inc.'s Designated Copyright Agent:
          <br />
          CEO
          <br />
          SageMath, Inc.
          <br />
          17725 SE 123RD PL
          <br />
          Renton, WA 98059
          <br />
          Phone: (509) 818-0964
          <br />
          Email:{" "}
          <A href="mailto:copyright@sagemath.com">
            copyright@sagemath.com
          </A>
        </p>
      </PolicySection>
      <PolicySection title="DMCA Counter Notice">
        <p>
          If you believe that material you posted on or through the Sites
          was removed or disabled by mistake or misidentification, you may
          send a counter notice to SageMath's Designated Copyright Agent
          that includes:
        </p>
        <ol>
          <li>
            Your full legal name and your electronic or physical
            signature.
          </li>
          <li>
            Identification of the material that has been removed or to
            which access has been disabled and the location at which the
            material appeared before it was removed or disabled.
          </li>
          <li>
            A statement under penalty of perjury that you have a good
            faith belief that the material was removed or disabled as a
            result of mistake or misidentification.
          </li>
          <li>
            Your mailing address, telephone number, and email address.
          </li>
          <li>
            A statement that you consent to the jurisdiction of the
            Federal District Court for the judicial district in which your
            address is located, or if your address is outside the United
            States, for any judicial district in which SageMath may be
            found, and that you will accept service of process from the
            person who provided the original Notice or that person's
            agent.
          </li>
        </ol>
        <p>
          Deliver this counter notice to SageMath, Inc.'s Designated
          Copyright Agent using the contact information above.
        </p>
      </PolicySection>
    </>
  ),
};

export default copyrightPolicy;
