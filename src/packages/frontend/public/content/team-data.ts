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
    email: "wstein@sagemath.com",
    imageSrc: "/public/about/william-stein.png",
    imageAlt: "William Stein with his dog, Bella.",
    summary:
      "Founder of SageMath and CoCalc, leading product direction, engineering, and long-term strategy.",
    role: [
      "William is both CEO and a lead software developer across the front and back end of CoCalc.",
      "His work on SageMath and his years as a professor of mathematics shape the product's emphasis on serious technical computing, teaching, and open infrastructure.",
    ],
    personal: [
      "In his role as CEO, William steers the company's growth, keeps a close eye on technical and business risk, and pushes CoCalc toward ambitious new capabilities.",
      "Outside work, he still has the same hands-on interest in mathematics, software, snow, ramps, and open systems that led him to build SageMath and then CoCalc in the first place.",
    ],
    background: [
      "William began his academic path at UC Berkeley, where heavy use of closed mathematical software convinced him that transparent, inspectable tools mattered deeply for research.",
      "That led to the creation of SageMath while he was on the mathematics faculty at Harvard, and later to SageMathCloud, now CoCalc, as a way to make serious technical software collaborative and easy to use online.",
      "CoCalc grew out of the practical needs of teaching, research, and open-source computation, and William remains deeply involved in the details of making it reliable and useful.",
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
    email: "hsy@sagemath.com",
    imageSrc: "/public/about/harald-schilly.jpg",
    imageAlt: "Harald Schilly with his dog.",
    summary:
      "CTO at SageMath, Inc., focused on infrastructure, engineering quality, and the overall technical direction of CoCalc.",
    role: [
      "Harald drives front-end and back-end engineering, Linux operations, deployment infrastructure, and broad technical direction across CoCalc.",
      "He has been a long-time SageMath contributor and brings a rare mix of mathematical background, systems knowledge, and hands-on software engineering.",
    ],
    personal: [
      "Harald enjoys cooking, the outdoors, and the kind of deep technical curiosity that keeps him evaluating new tools long after the workday is over.",
      "That curiosity shows up in CoCalc as sustained attention to infrastructure, performance, and practical engineering details.",
    ],
    background: [
      "Harald has been writing software since his teenage years, moving from early DOS-era programming into Java, Python, JavaScript, C, and systems engineering.",
      "His studies in applied mathematics and optimization deepened his interest in algorithms, while work on SageMath and Linux operations gave him the platform-level perspective that CoCalc needs.",
      "Since 2015, he has been central to CoCalc's growth as a reliable online environment for technical computing.",
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
    email: "andrey@cocalc.com",
    imageSrc: "/public/about/andrey-novoseltsev.jpeg",
    imageAlt: "A portrait of Andrey Novoseltsev smiling.",
    summary:
      "COO at SageMath, Inc., combining operations, finance, purchasing support, and deep SageMath experience.",
    role: [
      "Andrey oversees operations, purchasing flows, and financial details that keep the business side of CoCalc running smoothly.",
      "He is also an early SageMath developer and long-time advocate for using computational tools effectively in teaching.",
    ],
    personal: [
      "Outside work, Andrey is a father, hiker, and someone who can be equally enthusiastic about mathematics, woodworking, and backpacking.",
      "That mix of technical and practical perspective shows up in his focus on tools that help instructors and institutions operate smoothly.",
    ],
    background: [
      "Andrey studied and taught mathematics in Russia, the United States, and Canada, and used SageMath heavily in both research and instruction.",
      "He helped build SageMath functionality for toric and Calabi-Yau geometry, maintained SageMathCell, and developed interactive teaching tools for courses using linear programming and differential equations.",
      "That history made him one of the early people to see how important platforms like CoCalc are for technical teaching at scale.",
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
    email: "blaec@cocalc.com",
    imageSrc: "/public/about/blaec-bejarano.png",
    imageAlt: "A portrait of Blaec Bejarano.",
    summary:
      "CSO at SageMath, Inc., focused on partnerships, outreach, technical demos, and growth.",
    role: [
      "Blaec leads sales and partnership work, helping institutions and technical teams understand how CoCalc fits into their workflows.",
      "He combines applied mathematics, teaching experience, and active community engagement with a strong focus on product communication.",
    ],
    personal: [
      "Blaec is active in academic, startup, and technical communities and spends a remarkable amount of time presenting, traveling, and building relationships around open technical tools.",
      "Outside work he is also a mountain climber and musician, which fits the same pattern of energy and range that he brings to SageMath, Inc.",
    ],
    background: [
      "Blaec earned his M.S. in Mathematics at Oregon State University with work grounded in numerical analysis and applied mathematics.",
      "His years teaching mathematics, doing demos, and working with technical communities made him a natural fit for explaining what CoCalc makes possible and where it fits in research and education.",
      "He also helps connect CoCalc to broader open-source and industry ecosystems through talks, partnerships, and conference outreach.",
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
