/*
 *  This file is part of CoCalc: Copyright © 2021-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  A,
  PolicySection,
  PolicySubsection,
  type PublicPolicy,
} from "./policy";

export const termsPolicy: PublicPolicy = {
  description: "The core terms governing use of CoCalc and related services.",
  navLabel: "Terms",
  slug: "terms",
  title: "Terms of Service",
  updated: "June 30, 2026",
  content: (
    <>
      <p>
        Welcome to the SageMath, Inc. ("<b>SMI</b>") website located at{" "}
        <A href="https://cocalc.ai">https://cocalc.ai</A> (the "<b>Site</b>").
        Please read these Terms of Service (the "<b>Terms</b>") carefully
        because they govern your use of our Site and services accessible via our
        Site. To make these Terms easier to read, the Site and our services are
        collectively called the "<b>Services</b>".{" "}
      </p>
      <PolicySection title="Agreement to Terms">
        <p>
          By using our Services, you agree to be bound by these Terms. If you
          don’t agree to these Terms, do not use the Services. If you are
          accessing and using the Services on behalf of a company (such as your
          employer) or other legal entity, you represent and warrant that you
          have the authority to bind that company or other legal entity to these
          Terms. In that case, "you" and "your" will refer to that company or
          other legal entity.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Changes to Terms or Services">
        <p>
          We may modify the Terms at any time, in our sole discretion. If we do
          so, we’ll let you know either by posting the modified Terms on the
          Site at <A href="/policies/terms">https://cocalc.ai/policies/terms</A>{" "}
          or through other communications. You can track complete details
          regarding every change{" "}
          <A href="https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/frontend/public/policies">
            https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/frontend/public/policies
          </A>
          . It’s important that you review the Terms whenever we modify them
          because if you continue to use the Services after we have posted
          modified Terms on the Site, you are indicating to us that you agree to
          be bound by the modified Terms. If you don’t agree to be bound by the
          modified Terms, then you may not use the Services anymore. Because our
          Services are evolving over time we may change or discontinue all or
          any part of the Services, at any time and without notice, at our sole
          discretion.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Who May Use the Services">
        <PolicySubsection title="Eligibility">
          <p>
            You may use the Services only if you are 13 years (16, if you are an
            EU citizen) or older and are not barred from using the Services
            under applicable law.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Registration and Your Information">
          <p>
            If you want to use certain features of the Services you’ll have to
            create an account ("<b>Account</b>"). You can do this via the Site.
            You must provide a name, email address, and any other information
            requested in order to complete the signup process and register your
            Account. You’re responsible for all activities that occur under your
            Account, whether or not you know about them. (Note: before September
            2020, this paragraph was significantly more restrictive and we
            relaxed it to better support student privacy requirements.){" "}
          </p>
        </PolicySubsection>
      </PolicySection>
      <PolicySection title="Using the Services">
        <PolicySubsection title="Projects and Files">
          <p>
            The Services offer a web-based environment through which users can
            use SageMath and other open source math software online in
            connection with mathematical research and teaching and the
            performance of computational mathematics. Through their Accounts,
            users can create multiple projects ("<b>Project</b>"), each of which
            acts as a virtual computer with a file system with multiple
            directories, inside of which a user can create and edit any number
            of files of any type (such as Latex documents, Jupyter notebooks,
            and many others) as well as write, compile, and run software code in
            various programming languages (such files and code collectively, "
            <b>Files</b>"). You’ll be able to share your Files with other users
            of the Services, as well as enable them to contribute to and build
            upon them and share them as well. When you create Files, you can, if
            you choose, specify the terms and conditions that govern other
            users’ use of your Files (e.g. a specific software or creative
            commons license) ("
            <b>File License</b>"). Similarly, if you download, access or use
            another user’s Files through the Services, you agree that you will
            use such Files strictly in accordance with the File License terms
            associated with that File (if any), as indicated through the
            Services. If you don’t agree with the terms of a File License, then
            you may not use the applicable Files.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Collaborators">
          <p>
            You can elect to share your Files (which comprise User Content
            (defined below)) with one or more Account holders of your choosing
            (each, a "<b>Collaborator</b>", and collectively, a "
            <b>Collaborator Team</b>"). By doing so, you are authorizing each
            Account holder member of such Collaborator Team to use such Files in
            accordance with the applicable File License you’ve specified for
            such Files through the Services. If you haven’t specified an
            applicable File License, then you authorize SMI to grant each
            Account holder member of such Collaborator Team a non-exclusive,
            worldwide, non-transferable, sublicenseable (to other Collaborators)
            license to copy, modify, create derivative works based upon, and
            publicly display, your Files. Each Collaborator can make your Files
            public, by Posting them (as described below). Additionally, each
            Collaborator can elect to share your Files with other Account
            holders. Such additional Account holders will become part of the
            Collaborator Team, and will have the same rights to access and use
            your Files as those granted to Collaborators in this paragraph.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Posting">
          <p>
            You may also make your Files available to a broader audience by
            posting them through our Services (hereinafter, "<b>Posting</b>
            ") to the general public. Keep in mind that, by Posting such Files,
            you are (i) authorizing all Account holders and non-Account holder
            users of the Services to access and use such Files in accordance
            with the applicable File License you’ve specified for such Files
            through the Services, or if no File License is applicable; (ii)
            authorizing SMI to grant (a) Account holders a non-exclusive,
            worldwide, non-transferable license to view, copy, and publicly
            display, your Files; and (b) non-Account holder users of the Service
            a non-exclusive, non-transferable license to view such Files.{" "}
            <span className="uppercase">
              Once you POST TO THE GENERAL PUBLIC, you can LATER un-POST, but
              the licenses granted will remain in effect. You cannot revoke this
              license, so we encourage you to consider carefully before
              POSTING.{" "}
            </span>{" "}
          </p>
        </PolicySubsection>
      </PolicySection>
      <PolicySection title="API Terms">
        <p>
          You may access your Account data via our application programming
          interface ("<b>API</b>"). Your use of the API, including use through a
          third party product that accesses the Services, is subject to these
          Terms as well as the following specific terms:{" "}
        </p>
        <ul>
          <li>
            You expressly understand and agree that SMI shall not be liable for
            any direct, indirect, incidental, special, consequential or
            exemplary damages, including but not limited to, damages for loss of
            profits, goodwill, use, data or other intangible losses (even if SMI
            has been advised of the possibility of such damages), resulting from
            your use of the API or third-party products that access data via the
            API.{" "}
          </li>
          <li>
            Abuse of or excessively frequent requests to the Services via the
            API may result in the temporary or permanent suspension of your
            access to the API. SMI, in its sole discretion, will determine abuse
            or excessive usage of the API. SMI will make a reasonable attempt
            via email to warn you prior to permanent suspension.{" "}
          </li>
          <li>
            SMI reserves the right at any time to modify or discontinue,
            temporarily or permanently, your access to the API (or any part
            thereof) with or without notice.{" "}
          </li>
          <li>
            Unauthorized access to the API is not allowed from third party
            software. You must create your own account and provision an API key
            in order to use the API.
          </li>
        </ul>
      </PolicySection>
      <PolicySection title="Payments and Account Credit">
        <p>
          Your use of the Services may be free or subject to fees. Fees may be
          fixed, recurring, usage-based, invoiced, prepaid, or otherwise
          described in the Service at the time of purchase or use. Paid Services
          may include free trial periods, during which you may be required to
          provide a payment method and authorize renewal or conversion to a paid
          period unless you cancel before the trial ends.
        </p>
        <p>
          If you use paid Services, you must provide SMI with complete and
          accurate billing and contact information. You agree to pay all
          applicable fees and taxes, and authorize SMI or its third party
          payment processor to charge your selected payment method, invoice you,
          or apply your CoCalc account credit or account balance ("
          <b>Account Credit</b>"), as applicable.
        </p>
        <p>
          All fees are exclusive of taxes, levies, or duties imposed by taxing
          authorities, and you are responsible for payment of all such taxes,
          levies, or duties, excluding only United States (federal or state)
          taxes on SMI’s net income.
        </p>
        <PolicySubsection title="Account Credit and Usage-Based Services">
          <p>
            Some Services may require sufficient Account Credit, an approved
            payment method, postpaid billing authorization, or another billing
            arrangement before you can access or continue using them.
          </p>
          <p>
            Account Credit has no cash value and is provided on a non-refundable
            basis. It may be used toward usage-based Services or to purchase
            paid Services, as supported by the Service. Usage-based Services may
            be suspended or terminated immediately if your Account Credit
            becomes negative, your payment method fails, or your billing
            authorization is no longer sufficient.
          </p>
        </PolicySubsection>
        <PolicySubsection title="Access, Downgrades, and Data">
          <p>
            Changes to paid Services, including upgrades, downgrades,
            cancellations, and renewals, may take effect immediately or at the
            end of the then-current billing period, as shown in the Service at
            the time of the change. We may suspend or terminate paid Services if
            fees are past due.
          </p>
          <p>
            Downgrading, canceling, failing to renew, failing to pay, or
            otherwise changing your paid Services may cause loss of access to
            Content, features, compute resources, storage, backups, or other
            capacity of your Account. SMI does not accept liability for such
            loss. You are responsible for exporting or backing up Content you
            wish to retain. We may delete, disable, or limit access to Accounts,
            projects, files, backups, or other Content after cancellation,
            termination, extended inactivity, nonpayment, or if your Content
            exceeds the resources allocated to your Account, subject to
            applicable law and our other policies.
          </p>
        </PolicySubsection>
        <PolicySubsection title="Refunds and Changes">
          <p>
            All payments are non-refundable except for billing errors or as
            expressly stated by SMI. There will be no refunds or credits for
            partial months or years of service, unused time, unused resources,
            or unused Account Credit.
          </p>
          <p>
            Fees for paid Services are subject to change. For automatically
            renewing paid Services, we will provide notice before fee changes
            take effect. For usage-based Services, such as dedicated compute
            resources, fees may change without advance notice by posting the
            changes to the Site or the Service itself.
          </p>
        </PolicySubsection>
      </PolicySection>
      <PolicySection title="Feedback">
        <p>
          We welcome feedback, comments and suggestions for improvements to the
          Services ("<b>Feedback</b>"). You can submit Feedback by emailing us
          at <A href="mailto:help@sagemath.com">help@sagemath.com</A> or using
          internal messaging system. You grant to us a non-exclusive, worldwide,
          perpetual, irrevocable, fully-paid, royalty-free, sublicensable and
          transferable license under any and all intellectual property rights
          that you own or control to use, copy, modify, create derivative works
          based upon and otherwise exploit the Feedback for any purpose.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Privacy Policy">
        <p>
          Please refer to our Privacy Policy (
          <A href="/policies/privacy">https://cocalc.ai/policies/privacy</A>)
          for information on how we collect, use and disclose information from
          our users. Where SageMath, Inc. processes personal data on your behalf
          as a Data Processor, such processing is governed by our Data
          Processing Addendum (
          <A href="/policies/dpa">https://cocalc.ai/policies/dpa</A>), which is
          hereby incorporated into these Terms by reference.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Content and Content Rights">
        <p>
          For purposes of these Terms: (i) "<b>Content</b>" means text,
          graphics, images, software, works of authorship of any kind, and
          information or other materials that are posted, generated, provided or
          otherwise made available through the Services; and (ii) "
          <b>User Content</b>" means any Content that Account holders (including
          you) provide to be made available through the Services (including
          without limitation, Files). Content includes without limitation User
          Content.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Content Ownership and Responsibility">
        <p>
          SMI does not claim any ownership rights in any User Content and
          nothing in these Terms will be deemed to restrict any rights that you
          may have to use and exploit your User Content. Subject to the
          foregoing, SMI and its licensors exclusively own all right, title and
          interest in and to the Services and Content, including all associated
          intellectual property rights. You acknowledge that the Services and
          Content are protected by copyright, trademark, and other laws of the
          United States and foreign countries. You agree not to remove, alter or
          obscure any copyright, trademark, service mark or other proprietary
          rights notices incorporated in or accompanying the Services or
          Content.{" "}
        </p>
        <PolicySubsection title="Rights in User Content Granted by You">
          <p>
            By making any User Content available through Services: (i) you
            hereby grant to SMI a non-exclusive, transferable, sublicenseable,
            worldwide, royalty-free license to use, copy, modify, create
            derivative works based upon, publicly display, publicly perform and
            distribute your User Content in connection with operating and
            providing the Services and Content; and (ii) you hereby grant to
            Account holders and non-Account holder users of the Services who are
            permitted access to your Files the right to use your Files in
            accordance with the applicable File Licenses you have indicated
            govern use of your Files (if any).{" "}
          </p>
          <p>
            You are solely responsible for all your User Content. You represent
            and warrant that you own all your User Content or you have all
            rights that are necessary to grant us the license rights in your
            User Content under these Terms. You also represent and warrant that
            neither your User Content, nor your use and provision of your User
            Content to be made available through the Services, nor any use of
            your User Content by SMI on or through the Services will infringe,
            misappropriate or violate a third party’s intellectual property
            rights, or rights of publicity or privacy, or result in the
            violation of any applicable law or regulation.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Aggregate Data Usage">
          <p>
            You acknowledge and agree that SMI may (i) collect anonymous usage
            and performance data with respect to your use of the Services, and
            the performance of the Services in connection with your use; and
            (ii) analyze your User Content on an anonymous aggregate basis, in
            each case for the purposes of measuring and analyzing usage and
            performance of, and improving, testing and providing, the Services
            and additional services. SMI will use and disclose (and you hereby
            authorize SMI to use and disclose) this data only in aggregate form
            (i.e., data aggregated from various users’ use of the Services, but
            not specifically identifying you).{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Rights in Content Granted by SMI">
          <p>
            Subject to your compliance with these Terms, SMI grants you, if you
            are a non-Account holder user of the Services, a limited,
            non-exclusive, non-transferable license to view any Content to which
            you are permitted access solely in connection with your permitted
            use of the Services.{" "}
          </p>
          <p>
            Subject to your compliance with these Terms, SMI grants you, if you
            are an Account holder, a limited, non-exclusive, worldwide,
            non-transferable license to copy, modify, create derivative works
            based upon, and publicly display the Content (excluding any User
            Content) solely in connection with your permitted use of the
            Services and solely in connection with your permitted use of the
            Services.{" "}
          </p>
        </PolicySubsection>
      </PolicySection>
      <PolicySection title="General Prohibitions and SMI’s Enforcement Rights">
        <p> You agree not to do any of the following:</p>
        <ul>
          <li>
            Post, upload, publish, submit or transmit any Content that: (i)
            infringes, misappropriates or violates a third party’s patent,
            copyright, trademark, trade secret, moral rights or other
            intellectual property rights, or rights of publicity or privacy;
            (ii) violates, or encourages any conduct that would violate, any
            applicable law or regulation or would give rise to civil liability;
            (iii) is fraudulent, false, misleading or deceptive; (iv) is
            defamatory, obscene, pornographic, vulgar or offensive; (v) promotes
            discrimination, bigotry, racism, hatred, harassment or harm against
            any individual or group; (vi) is violent or threatening or promotes
            violence or actions that are threatening to any person or entity; or
            (vii) promotes illegal or harmful activities or substances.{" "}
          </li>
          <li>
            Use, display, mirror or frame the Services or any individual element
            within the Services, SMI’s name, any SMI trademark, logo or other
            proprietary information, or the layout and design of any page or
            form contained on a page, without SMI’s express written
            consent;{" "}
          </li>
          <li>
            Access, tamper with, or use non-public areas of the Services, SMI’s
            computer systems, or the technical delivery systems of SMI’s
            providers;{" "}
          </li>
          <li>
            Attempt to probe, scan or test the vulnerability of any SMI system
            or network or breach any security or authentication measures without
            SMI’s express written consent;{" "}
          </li>
          <li>
            Avoid, bypass, remove, deactivate, impair, descramble or otherwise
            circumvent any technological measure implemented by SMI or any of
            SMI’s providers or any other third party (including another user) to
            protect the Services or Content;{" "}
          </li>
          <li>
            Attempt to access or search the Services or Content or download
            Content from the Services through the use of any engine, software,
            tool, agent, device or mechanism (including spiders, robots,
            crawlers, data mining tools or the like) other than the software
            and/or search agents provided by SMI or other generally available
            third-party web browsers;{" "}
          </li>
          <li>
            Send any unsolicited or unauthorized advertising, promotional
            materials, email, junk mail, spam, chain letters or other form of
            solicitation;{" "}
          </li>
          <li>
            Use any meta tags or other hidden text or metadata utilizing a SMI
            trademark, logo URL or product name without SMI’s express written
            consent;{" "}
          </li>
          <li>
            Use the Services or Content, or any portion thereof, in any manner
            not permitted by these Terms;{" "}
          </li>
          <li>
            Forge any TCP/IP packet header or any part of the header information
            in any email or newsgroup posting, or in any way use the Services or
            Content to send altered, deceptive or false source-identifying
            information;{" "}
          </li>
          <li>
            Interfere with, or attempt to interfere with, the access of any
            user, host or network, including, without limitation, sending a
            virus, overloading, flooding, spamming, or mail-bombing the
            Services;{" "}
          </li>
          <li>
            Impersonate or misrepresent your affiliation with any person or
            entity;{" "}
          </li>
          <li>Violate any applicable law or regulation; or </li>
          <li>
            Encourage or enable any other individual to do any of the
            foregoing.{" "}
          </li>
        </ul>
        <p>
          Although we’re not obligated to monitor access to or use of the
          Services or Content or to review or edit any Content, we have the
          right to do so for the purpose of operating the Services, to ensure
          compliance with these Terms, and to comply with applicable law or
          other legal requirements. We reserve the right, but are not obligated,
          to remove or disable access to any Content, at any time and without
          notice, including, but not limited to, if we, at our sole discretion,
          consider any Content to be objectionable or in violation of these
          Terms. We have the right to investigate violations of these Terms or
          conduct that affects the Services. We may also consult and cooperate
          with law enforcement authorities to prosecute users who violate the
          law. If your usage of resources (including compute, memory, storage,
          or bandwidth) in connection with your use of the Services
          significantly exceeds average usage levels or otherwise deviates from
          intended use (as determined solely by SMI), we reserve the right to
          immediately disable your Account or throttle your use of the Services
          until you can reduce your consumption.{" "}
        </p>
      </PolicySection>
      <PolicySection title="DMCA/Copyright Policy">
        <p>
          SMI respects copyright law and expects its users to do the same. It is
          SMI’s policy to terminate in appropriate circumstances Account holders
          who repeatedly infringe the rights of copyright holders. Please see
          SMI’<i>s</i> Copyright and IP Policy at{" "}
          <A href="/policies/copyright">https://cocalc.ai/policies/copyright</A>{" "}
          for further information.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Links to Third Party Websites or Resources">
        <p>
          The Services may contain links to third-party websites or resources.
          We provide these links only as a convenience and are not responsible
          for the content, products or services on or available from those
          websites or resources or links displayed on such websites. You
          acknowledge sole responsibility for and assume all risk arising from,
          your use of any third-party websites or resources.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Termination">
        <p>
          We may terminate or suspend your access to and use of the Services, at
          our sole discretion, at any time and without notice to you. You may
          cancel your Account at any time by clicking on the Account link in the
          global navigation bar at the top of the screen through which you are
          accessing the Services. Upon any termination, discontinuation or
          cancelation of Services or your Account, the following provisions of
          these Terms will survive: Feedback; Privacy Policy; Content and
          Content Rights; Content Ownership and Responsibility (excluding Rights
          in Content granted by SMI); General Prohibitions and SMI’s Enforcement
          Rights; Indemnity; Limitation of Liability; Dispute Resolution;
          Governing Law and Jurisdiction; General Terms.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Warranty Disclaimers">
        <p className="uppercase">
          The Services and Content are provided "AS IS," without warranty of any
          kind. Without limiting the foregoing, WE EXPLICITLY DISCLAIM ANY
          WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, QUIET
          ENJOYMENT OR NON-INFRINGEMENT, AND ANY WARRANTIES ARISING OUT OF
          COURSE OF DEALING OR USAGE OF TRADE. WE MAKE NO WARRANTY THAT THE
          SERVICES OR CONTENT WILL MEET YOUR REQUIREMENTS OR EXPECTATIONS OR BE
          AVAILABLE ON AN UNINTERRUPTED, SECURE, OR ERROR-FREE BASIS. WE MAKE NO
          WARRANTY (I) REGARDING THE QUALITY, ACCURACY, TIMELINESS,
          TRUTHFULNESS, COMPLETENESS OR RELIABILITY OF THE SERVICES OR ANY
          CONTENT; OR (II) THAT ANY CONTENT DOWNLOADED OR OTHERWISE ACCESSIBLE
          BY YOU THROUGH THE SERVICES WILL BE FREE FROM ANY VIRUSES, TROJAN
          HORSES, WORMS, OR OTHER COMPUTER PROGRAMMING DEVICES WHICH MAY DAMAGE
          A USER’S COMPUTER, SYSTEM OR DATA OR PREVENT THE USER FROM USING ITS
          COMPUTER, SYSTEM OR DATA. YOU KNOWINGLY AND FREELY ASSUME ALL RISK
          WHEN USING THE SERVICES AND THE CONTENT.{" "}
        </p>
        <p className="uppercase">
          THE CONTENT PROVIDED BY ACCOUNT HOLDERS AND THE USE OF CONTENT BY
          ACCOUNT HOLDERS AND NON-ACCOUNT HOLDER USERS IS ENTIRELY THE
          RESPONSIBILITY OF THE APPLICABLE ACCOUNT HOLDER OR NON-ACCOUNT HOLDER
          USER WHO PROVIDES OR USES THE CONTENT, AS APPLICABLE. WE DISCLAIM ALL
          LIABILITY IN CONNECTION WITH OR ARISING FROM (I) ANY ACTS, OMISSIONS
          OR NEGLIGENCE ON THE PART OF ACCOUNT HOLDERS; (II) ACCOUNT HOLDER’S OR
          NON-ACCOUNT HOLDER USERS’ USE OF THE USER CONTENT, INCLUDING
          NON-COMPLIANCE WITH FILE LICENSES; AND (III) ANY LOSS OR DAMAGE
          CAUSED, INCLUDING, DAMAGES TO PROPERTY, LOSS OF SERVICES OR OTHER
          DAMAGES OR HARM, WHETHER TO YOU OR TO THIRD PARTIES, WHICH MAY RESULT
          FROM YOUR USE OF THE SERVICES AND CONTENT. IN THE EVENT OF AN ACCOUNT
          HOLDERS’ OR NON-ACCOUNT HOLDER USERS’ NON-COMPLIANCE WITH YOUR FILE
          LICENSE, YOU AGREE THAT YOUR ONLY RECOURSE IS AGAINST THE APPLICABLE
          ACCOUNT HOLDER OR NON-ACCOUNT HOLDER USER WHO DOWNLOADS THE
          CONTENT.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Indemnity">
        <p>
          You will indemnify and hold harmless SMI and its officers, directors,
          employees and agents, from and against any claims, disputes, demands,
          liabilities, damages, losses, and costs and expenses, including,
          without limitation, reasonable legal and accounting fees arising out
          of or in any way connected with (i) your access to or use of the
          Services or Content, (ii) your User Content, or (iii) your violation
          of these Terms (including without limitation your use of a File other
          than in accordance with the applicable File License and a breach by
          you of any representations or warranties in these Terms).{" "}
        </p>
      </PolicySection>
      <PolicySection title="Limitation of Liability">
        <p className="uppercase">
          NEITHER SMI NOR ANY OTHER PARTY INVOLVED IN CREATING, PRODUCING, OR
          DELIVERING THE SERVICES OR CONTENT WILL BE LIABLE FOR ANY INCIDENTAL,
          SPECIAL, EXEMPLARY OR CONSEQUENTIAL DAMAGES, INCLUDING LOST PROFITS,
          LOSS OF DATA OR GOODWILL, SERVICE INTERRUPTION, COMPUTER DAMAGE OR
          SYSTEM FAILURE OR THE COST OF SUBSTITUTE SERVICES ARISING OUT OF OR IN
          CONNECTION WITH THESE TERMS OR FROM THE USE OF OR INABILITY TO USE THE
          SERVICES OR CONTENT, WHETHER BASED ON WARRANTY, CONTRACT, TORT
          (INCLUDING NEGLIGENCE), PRODUCT LIABILITY OR ANY OTHER LEGAL THEORY,
          AND WHETHER OR NOT SMI HAS BEEN INFORMED OF THE POSSIBILITY OF SUCH
          DAMAGE, EVEN IF A LIMITED REMEDY SET FORTH HEREIN IS FOUND TO HAVE
          FAILED OF ITS ESSENTIAL PURPOSE.
          <span>
            {" "}
            SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF
            LIABILITY FOR CONSEQUENTIAL OR INCIDENTAL DAMAGES, SO THE ABOVE
            LIMITATION MAY NOT APPLY TO YOU.{" "}
          </span>
        </p>
        <p className="uppercase">
          In no event will SMI's total liability arising out of or in connection
          with THESE TERMS OR FROM THE USE OF OR INABILITY TO USE the ServiceS
          or content EXCEED THE AMOUNTS YOU HAVE PAID TO SMI FOR USE OF THE
          SERVICES OR content OR ONE HUNDRED DOLLARS ($100), IF YOU HAVE NOT HAD
          ANY PAYMENT OBLIGATIONS TO SMI, AS APPLICABLE.{" "}
        </p>
        <p>
          THE EXCLUSIONS AND LIMITATIONS OF DAMAGES SET FORTH ABOVE ARE
          FUNDAMENTAL ELEMENTS OF THE BASIS OF THE BARGAIN BETWEEN SMI AND
          YOU.{" "}
        </p>
      </PolicySection>
      <PolicySection title="Dispute Resolution">
        <PolicySubsection title="Governing Law">
          <p>
            These Terms and any action related thereto will be governed by the
            laws of the State of California without regard to its conflict of
            laws provisions.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Agreement to Arbitrate">
          <p>
            You and SMI agree that any dispute, claim or controversy arising out
            of or relating to these Terms or the breach, termination,
            enforcement, interpretation or validity thereof or the use of the
            Services or Content (collectively, "<b>Disputes</b>") will be
            settled by binding arbitration, except that each party retains the
            right: (i) to bring an individual action in small claims court and
            (ii) to seek injunctive or other equitable relief in a court of
            competent jurisdiction to prevent the actual or threatened
            infringement, misappropriation or violation of a party’s copyrights,
            trademarks, trade secrets, patents or other intellectual property
            rights (the action described in the foregoing clause (ii), an "
            <b>IP Protection Action</b>"). The exclusive jurisdiction and venue
            of any IP Protection Action will be the state and federal courts
            located in the Northern District of California and each of the
            parties hereto waives any objection to jurisdiction and venue in
            such courts.{" "}
            <b>
              You acknowledge and agree that you and SMI are each waiving the
              right to a trial by jury or to participate as a plaintiff or class
              member in any purported class action or representative proceeding.
            </b>{" "}
            Further, unless both you and SMI otherwise agree in writing, the
            arbitrator may not consolidate more than one person's claims, and
            may not otherwise preside over any form of any class or
            representative proceeding. If this specific paragraph is held
            unenforceable, then the entirety of this "Dispute Resolution"
            section will be deemed void. Except as provided in the preceding
            sentence, this "Dispute Resolution" section will survive any
            termination of these Terms.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Arbitration Rules">
          <p>
            The arbitration will be administered by the American Arbitration
            Association ("<b>AAA</b>") in accordance with the Commercial
            Arbitration Rules and the Supplementary Procedures for Consumer
            Related Disputes (the "<b>AAA Rules</b>") then in effect, except as
            modified by this "Dispute Resolution" section. (The AAA Rules are
            available at{" "}
            <A href="http://www.adr.org/arb_med">www.adr.org/arb_med</A> or by
            calling the AAA at 1-800-778-7879.) The Federal Arbitration Act will
            govern the interpretation and enforcement of this Section.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Arbitration Process">
          <p>
            A party who desires to initiate arbitration must provide the other
            party with a written Demand for Arbitration as specified in the AAA
            Rules. (The AAA provides a form Demand for Arbitration at{" "}
            <A href="http://www.adr.org/aaa/ShowPDF?doc=ADRSTG_015820">
              {" "}
              http://www.adr.org/aaa/ShowPDF?doc=ADRSTG_015820
            </A>{" "}
            and a separate form for California residents at{" "}
            <A href="http://www.adr.org/aaa/ShowPDF?doc=ADRSTG_015822">
              {" "}
              http://www.adr.org/aaa/ShowPDF?doc=ADRSTG_015822
            </A>
            ) The arbitrator will be either a retired judge or an attorney
            licensed to practice law and will be selected by the parties from
            the AAA’s roster of arbitrators. If the parties are unable to agree
            upon an arbitrator within seven (7) days of delivery of the Demand
            for Arbitration, then the AAA will appoint the arbitrator in
            accordance with the AAA Rules.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Arbitration Location and Procedure">
          <p>
            Unless you and SMI otherwise agree, the arbitration will be
            conducted in the county where you reside. If your claim does not
            exceed $10,000, then the arbitration will be conducted solely on the
            basis of the documents that you and SMI submit to the arbitrator,
            unless you request a hearing or the arbitrator determines that a
            hearing is necessary. If your claim exceeds $10,000, your right to a
            hearing will be determined by the AAA Rules. Subject to the AAA
            Rules, the arbitrator will have the discretion to direct a
            reasonable exchange of information by the parties, consistent with
            the expedited nature of the arbitration.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Arbitrator’s Decision">
          <p>
            The arbitrator will render an award within the time frame specified
            in the AAA Rules. The arbitrator’s decision will include the
            essential findings and conclusions upon which the arbitrator based
            the award. Judgment on the arbitration award may be entered in any
            court having jurisdiction thereof. The arbitrator’s award of damages
            must be consistent with the terms of the "Limitation of Liability"
            section above as to the types and amounts of damages for which a
            party may be held liable. The arbitrator may award declaratory or
            injunctive relief only in favor of the claimant and only to the
            extent necessary to provide relief warranted by the claimant’s
            individual claim. If you prevail in arbitration you will be entitled
            to an award of attorneys’ fees and expenses, to the extent provided
            under applicable law. SMI will not seek, and hereby waives all
            rights it may have under applicable law to recover, attorneys’ fees
            and expenses if it prevails in arbitration.{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Fees">
          <p>
            Your responsibility to pay any AAA filing, administrative and
            arbitrator fees will be solely as set forth in the AAA Rules.
            However, if your claim for damages does not exceed $75,000, SMI will
            pay all such fees unless the arbitrator finds that either the
            substance of your claim or the relief sought in your Demand for
            Arbitration was frivolous or was brought for an improper purpose (as
            measured by the standards set forth in Federal Rule of Civil
            Procedure 11(b)).{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="Changes">
          <p>
            Notwithstanding the provisions of the "Modification" section above,
            if SMI changes this "Dispute Resolution" section after the date you
            first accepted these Terms (or accepted any subsequent changes to
            these Terms), you may reject any such change by sending us written
            notice (including by email to{" "}
            <A href="mailto:help@sagemath.com">help@sagemath.com</A>) within 30
            days of the date such change became effective, as indicated in the
            "Last Updated" date above or in the date of SMI’s email to you
            notifying you of such change. By rejecting any change, you are
            agreeing that you will arbitrate any Dispute between you and SMI in
            accordance with the provisions of this "Dispute Resolution" section
            as of the date you first accepted these Terms (or accepted any
            subsequent changes to these Terms).{" "}
          </p>
        </PolicySubsection>
        <PolicySubsection title="General Terms">
          <p>
            These Terms constitute the entire and exclusive understanding and
            agreement between SMI and you regarding the Services and Content,
            and these Terms supersede and replace any and all prior oral or
            written understandings or agreements between SMI and you regarding
            the Services and Content. If for any reason a court of competent
            jurisdiction finds any provision of these Terms invalid or
            unenforceable, that provision will be enforced to the maximum extent
            permissible and the other provisions of these Terms will remain in
            full force and effect.{" "}
          </p>
          <p>
            You may not assign or transfer these Terms, by operation of law or
            otherwise, without SMI’s prior written consent. Any attempt by you
            to assign or transfer these Terms, without such consent, will be
            null. SMI may freely assign or transfer these Terms without
            restriction. Subject to the foregoing, these Terms will bind and
            inure to the benefit of the parties, their successors and permitted
            assigns.{" "}
          </p>
          <p>
            Any notices or other communications provided by SMI under these
            Terms, including those regarding modifications to these Terms, will
            be given: (i) via email; or (ii) by posting to the Services. For
            notices made by e-mail, the date of receipt will be deemed the date
            on which such notice is transmitted.{" "}
          </p>
          <p>
            SMI’s failure to enforce any right or provision of these Terms will
            not be considered a waiver of such right or provision. The waiver of
            any such right or provision will be effective only if in writing and
            signed by a duly authorized representative of SMI. Except as
            expressly set forth in these Terms, the exercise by either party of
            any of its remedies under these Terms will be without prejudice to
            its other remedies under these Terms or otherwise.{" "}
          </p>
          <p>
            The look and feel of the Services is copyright ©2015-2026 Sagemath,
            Inc. All rights reserved. You may only duplicate, copy, or reuse any
            portion of the HTML/CSS, Javascript, or visual design elements or
            concepts under the terms of the MICROSOFT REFERENCE SOURCE LICENSE
            (MS-RSL), as stated at{" "}
            <A href="https://github.com/sagemathinc/cocalc-ai">
              {" "}
              https://github.com/sagemathinc/cocalc-ai{" "}
            </A>
            .{" "}
          </p>
        </PolicySubsection>
      </PolicySection>
      <PolicySection title="Contact Information">
        <p>
          If you have any questions about these Terms or the Services, please
          contact SMI at{" "}
          <A href="mailto:help@sagemath.com">help@sagemath.com</A>.
        </p>
      </PolicySection>
    </>
  ),
};

export default termsPolicy;
