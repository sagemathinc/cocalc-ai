/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface TeamExperience {
  institution: string;
  position: string;
  timeframe: string;
}

export interface TeamMemberProfile {
  background: string[];
  email: string;
  experience: TeamExperience[];
  imageAlt: string;
  imageSrc: string;
  name: string;
  personal: string[];
  position: string;
  positionTimeframe: string;
  role: string[];
  slug: string;
  summary: string;
  title: string;
  website?: { href: string; label: string };
}

export const TEAM_MEMBERS: TeamMemberProfile[] = [
  {
    slug: "william-stein",
    name: "William Stein",
    title: "CEO and Founder",
    position: "Chief Executive Officer and Founder of SageMath, Inc.",
    positionTimeframe: "2015-present",
    email: "wstein@sagemath.com",
    imageSrc: "/public/about/william-stein.png",
    imageAlt: "William Stein with his dog, Bella.",
    summary:
      "Founder of SageMath and CoCalc, leading product direction, engineering, and long-term strategy across the entire company.",
    role: [
      "William is both the CEO and a lead software developer across the front and back end of CoCalc, with day-to-day involvement in product direction and engineering decisions.",
      "His long history with SageMath and his years as a professor of mathematics shape CoCalc's emphasis on serious technical computing, teaching, collaboration, and open infrastructure.",
    ],
    personal: [
      "As CEO, William steers growth strategy, delegates across the company, watches technical and business risk closely, and pushes CoCalc toward ambitious but practical new capabilities.",
      "Outside work, he still has the same hands-on interest in mathematics, software, snow, ramps, and open systems that led him to build SageMath and then CoCalc in the first place.",
    ],
    background: [
      "William's academic path began at UC Berkeley, where heavy use of closed mathematical software such as Magma convinced him that transparent, inspectable tools mattered deeply for research.",
      "That led to the creation of SageMath while he was on the mathematics faculty at Harvard, and later to SageMathCloud, now CoCalc, as a way to make serious technical software collaborative and easy to use online without the usual installation and package-maintenance headaches.",
      "CoCalc grew out of the practical needs of teaching, research, and open-source computation, and William remains deeply involved in making it stable, self-sustaining, and genuinely useful for technical work.",
    ],
    experience: [
      {
        institution: "SageMath, Inc.",
        position: "CEO and Founder",
        timeframe: "2015-present",
      },
      {
        institution: "University of Washington",
        position: "Tenured Professor of Mathematics",
        timeframe: "2006-2019",
      },
      {
        institution: "University of California San Diego",
        position: "Associate Professor of Mathematics",
        timeframe: "2005-2006",
      },
      {
        institution: "Harvard University",
        position: "Assistant Professor of Mathematics",
        timeframe: "2000-2005",
      },
      {
        institution: "University of California, Berkeley",
        position: "Ph.D. in Mathematics",
        timeframe: "1995-2000",
      },
    ],
    website: {
      href: "https://wstein.org/",
      label: "Personal website",
    },
  },
  {
    slug: "harald-schilly",
    name: "Harald Schilly",
    title: "CTO",
    position: "Chief Technology Officer at SageMath, Inc.",
    positionTimeframe: "2015-present",
    email: "hsy@sagemath.com",
    imageSrc: "/public/about/harald-schilly.jpg",
    imageAlt: "Harald Schilly with his dog.",
    summary:
      "CTO at SageMath, Inc., focused on infrastructure, engineering quality, and the overall technical direction of CoCalc.",
    role: [
      "Harald drives front-end and back-end engineering, Linux operations, deployment infrastructure, and technical evaluation across CoCalc.",
      "He has been a long-time SageMath contributor and brings a rare mix of mathematical background, systems knowledge, and hands-on software engineering.",
    ],
    personal: [
      "Harald enjoys time outdoors, cooking Italian food, and the kind of deep technical curiosity that keeps him evaluating new tools long after the workday is over.",
      "That curiosity shows up in CoCalc as sustained attention to infrastructure, performance, Linux systems, and practical engineering details.",
    ],
    background: [
      "Harald has been writing software since his teenage years, moving from early DOS-era programming into Java, Python, JavaScript, C, and systems engineering.",
      "His studies in applied mathematics and optimization deepened his interest in algorithms, and during his Ph.D. work at the University of Vienna he taught Linux system administration and introduced Python to undergraduates.",
      "Since 2015, he has been central to CoCalc's growth as a reliable online environment for technical computing, including the software stack, monitoring, and the enormous catalog of tools that users expect to be available out of the box.",
    ],
    experience: [
      {
        institution: "SageMath, Inc.",
        position: "CTO",
        timeframe: "2015-present",
      },
      {
        institution: "Self-employed",
        position: "IT Consultant",
        timeframe: "2015-present",
      },
      {
        institution: "Sage Open-Source Mathematical Software",
        position: "Developer",
        timeframe: "2007-present",
      },
      {
        institution: "University of Vienna",
        position: "Mathematician and Instructor",
        timeframe: "2006-2014",
      },
      {
        institution: "University of Vienna",
        position: "M.S. Mathematics",
        timeframe: "1999-2008",
      },
    ],
  },
  {
    slug: "andrey-novoseltsev",
    name: "Andrey Novoseltsev",
    title: "COO",
    position: "Chief Operations Officer at SageMath, Inc.",
    positionTimeframe: "2023-present",
    email: "andrey@cocalc.com",
    imageSrc: "/public/about/andrey-novoseltsev.jpeg",
    imageAlt: "A portrait of Andrey Novoseltsev smiling.",
    summary:
      "COO at SageMath, Inc., combining operations, finance, purchasing support, and deep SageMath experience.",
    role: [
      "Andrey keeps a close eye on the company's financial and operational details, and he is the person many customers work with when custom quotes, purchase orders, or invoices need special attention.",
      "He is also an early SageMath developer and a long-time advocate for using computational tools effectively in teaching.",
    ],
    personal: [
      "Outside work, Andrey is a father, hiker, and someone who can be equally enthusiastic about mathematics, woodworking, and backpacking.",
      "He enjoys learning about global geopolitical perspectives and thinking carefully about practical details, which fits his role in helping instructors and institutions operate smoothly.",
    ],
    background: [
      "Andrey studied and taught mathematics in Russia, the United States, and Canada, and used SageMath heavily in both research and instruction.",
      "He helped build SageMath functionality for toric and Calabi-Yau geometry, maintained SageMathCell, and developed many interactive teaching tools for courses using differential equations, multivariable calculus, and optimization.",
      "That history made him one of the early people to see how important platforms like CoCalc are for supporting instructors who want serious technical tooling without operational chaos.",
    ],
    experience: [
      {
        institution: "SageMath, Inc.",
        position: "COO",
        timeframe: "2023-present",
      },
      {
        institution: "SageMathCell",
        position: "Maintainer and Lead Developer",
        timeframe: "2014-present",
      },
      {
        institution: "SageMath",
        position: "Developer",
        timeframe: "2006-present",
      },
      {
        institution: "University of Alberta",
        position: "Postdoctoral Researcher",
        timeframe: "2011-2016",
      },
      {
        institution: "University of Alberta",
        position: "Ph.D. in Mathematics",
        timeframe: "2011",
      },
    ],
  },
  {
    slug: "blaec-bejarano",
    name: "Blaec Bejarano",
    title: "CSO",
    position: "Chief Sales Officer at SageMath, Inc.",
    positionTimeframe: "2022-present",
    email: "blaec@cocalc.com",
    imageSrc: "/public/about/blaec-bejarano.png",
    imageAlt: "A portrait of Blaec Bejarano.",
    summary:
      "CSO at SageMath, Inc., focused on partnerships, outreach, technical demos, and growth.",
    role: [
      "Blaec leads sales and partnership work, helping institutions and technical teams understand how CoCalc fits into their workflows through demos, conversations, and technical translation.",
      "He combines applied mathematics, teaching experience, and active community engagement with a strong focus on product communication and growth.",
    ],
    personal: [
      "Blaec is active in academic, startup, and technical communities and spends a remarkable amount of time presenting, traveling, and building relationships around open technical tools.",
      "Outside work he is also a mountain climber and musician, which fits the same energy and range that he brings to SageMath, Inc.",
    ],
    background: [
      "Blaec earned his M.S. in Mathematics at Oregon State University with work grounded in numerical analysis, applied mathematics, and modeling physical phenomena.",
      "His years teaching mathematics, doing demos, and working with technical communities made him a natural fit for explaining what CoCalc makes possible and where it fits in research, education, and technical organizations.",
      "He also connects CoCalc to broader open-source and industry ecosystems through talks, partnerships, conference outreach, and a steady stream of live product demonstrations.",
    ],
    experience: [
      {
        institution: "SageMath, Inc.",
        position: "CSO",
        timeframe: "2022-present",
      },
      {
        institution: "Oregon State University",
        position: "Instructor of Record",
        timeframe: "2019-2021",
      },
      {
        institution: "Oregon State University",
        position: "Graduate Teaching Assistant",
        timeframe: "2018-2021",
      },
      {
        institution: "Oregon State University",
        position: "M.S. Mathematics",
        timeframe: "2018-2021",
      },
      {
        institution: "University of West Florida",
        position: "B.A. History, B.S. Mathematics",
        timeframe: "2013-2017",
      },
    ],
  },
];

const TEAM_MEMBER_MAP = new Map(
  TEAM_MEMBERS.map((member) => [member.slug, member]),
);

export function getTeamMember(slug?: string): TeamMemberProfile | undefined {
  if (!slug) return;
  return TEAM_MEMBER_MAP.get(slug);
}
