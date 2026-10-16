/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getPublicTeamMember } from "@cocalc/util/public-about-content";

export interface TeamExperience {
  institution: string;
  position: string;
  timeframe: string;
}

export interface TeamSocialLinks {
  facebook?: string;
  github?: string;
  instagram?: string;
  linkedin?: string;
  twitter?: string;
  youtube?: string;
}

export interface TeamMemberProfile {
  background: string[];
  bioTopText: string[];
  cardText: string;
  email: string;
  experience: TeamExperience[];
  imageAlt: string;
  imageSrc: string;
  name: string;
  slug: string;
  socialLinks?: TeamSocialLinks;
  title: string;
  website?: { href: string; label: string };
}

export const TEAM_MEMBERS: TeamMemberProfile[] = [
  {
    ...getPublicTeamMember("william-stein")!,
    email: "wstein@sagemath.com",
    bioTopText: [
      "William is both the CEO and a lead software developer across the front and back end of CoCalc, with day-to-day involvement in product direction and engineering decisions.",
      "His long history with SageMath and his years as a professor of mathematics shape CoCalc's emphasis on technical computing, collaboration, open infrastructure, and teaching.",
    ],
    background: [
      'William\'s academic path began at the University of California, Berkeley, where he relied on closed-source software like Magma for analysis and research. An admirer of its underlying algorithms but wanting software that didn\'t operate as a "black box," he set out to understand "how things work under the hood" — which led him to develop SageMath while an Assistant Professor of Mathematics at Harvard.',
      "April 2013 marked another momentous chapter in William's professional life: he launched SageMathCloud, now known as CoCalc. Inspired by his experiences in the academic and computational fields, this web application was designed to enable the collaborative use of open-source software (while eliminating typical installation and package maintenance issues), thus enhancing the teaching and research process in mathematics and data science. CoCalc now operates under a corporate model, making it self-sufficient and capable of growth independent of grants or other external funding.",
      "William's not all business either. You can catch him making the most of Seattle's famously dismal winters by splitboarding with his Blue Heeler Bella in the Cascades or skating vert at \"the most rad private ramp in Seattle.\"",
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
        timeframe: "2010-2019",
      },
      {
        institution: "University of Washington",
        position: "Tenured Associate Professor of Mathematics",
        timeframe: "2006-2010",
      },
      {
        institution: "University of California San Diego",
        position: "Tenured Associate Professor of Mathematics",
        timeframe: "2005-2006",
      },
      {
        institution: "SageMath Open-Source Software",
        position: "Author",
        timeframe: "2004",
      },
      {
        institution: "Harvard University",
        position: "Benjamin Peirce Assistant Professor of Mathematics",
        timeframe: "2001-2005",
      },
      {
        institution: "University of California Berkeley",
        position: "Ph.D. in Mathematics",
        timeframe: "2000",
      },
    ],
    socialLinks: {
      facebook: "https://www.facebook.com/william.stein.37",
      github: "https://github.com/sagemathinc/cocalc",
      instagram: "https://www.instagram.com/wstein389/",
      linkedin: "https://www.linkedin.com/in/william-stein-895a26158/",
      twitter: "https://twitter.com/wstein389",
      youtube: "https://www.youtube.com/user/wstein389",
    },
    website: {
      href: "https://wstein.org/",
      label: "Personal website",
    },
  },
  {
    ...getPublicTeamMember("blaec-bejarano")!,
    email: "blaec@cocalc.ai",
    bioTopText: [
      "For partnerships, integrations, or questions about how CoCalc fits a research lab, technical team, or academic institution, Blaec is the person to talk to.",
      "He pairs a background in applied mathematics — numerical modeling of geophysical phenomena — with practical partnership work that helps technical evaluators connect CoCalc to their own workflows.",
      "He stays close to the applied-mathematics and open-source communities, including the Society for Industrial and Applied Mathematics, and represents CoCalc at conferences throughout the year.",
    ],
    background: [
      "Blaec earned his M.S. in Mathematics from Oregon State University in 2021, applying numerical analysis and partial differential equations to model physical phenomena, after teaching there as a graduate assistant and instructor of record.",
      "As Chief Sales Officer at SageMath, Inc., he leads sales, partnerships, and go-to-market, using live demos at conferences such as the International Congress on Industrial and Applied Mathematics (ICIAM) and the International Conference on Machine Learning (ICML) to translate CoCalc's capabilities into concrete adoption paths.",
      "He represents CoCalc across industry and open-source communities — including NumFOCUS, the National Small Business Association Leadership Technology Council, and the Seattle Chamber of Commerce — and leads partnership work that brings tools from proprietary ecosystems such as MATLAB toward open alternatives.",
      "Outside work, Blaec is a mountaineer who climbs the Cascade volcanoes of the Pacific Northwest and a musician who writes songs at home alongside his cat, Fushigi.",
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
    socialLinks: {
      facebook: "https://www.facebook.com/blaec.bejarano/",
      github: "https://github.com/sagemathinc/cocalc",
      instagram: "https://www.instagram.com/_blaec_/",
      linkedin: "https://www.linkedin.com/in/blaec-bejarano-500966b2/",
      twitter: "https://twitter.com/BlaecBejarano",
      youtube: "https://www.youtube.com/channel/UCoUBZX7c4sMcB3q6MYIW3-Q",
    },
  },
];

const TEAM_MEMBER_MAP = new Map(
  TEAM_MEMBERS.map((member) => [member.slug, member]),
);

export function getTeamMember(slug?: string): TeamMemberProfile | undefined {
  if (!slug) return;
  return TEAM_MEMBER_MAP.get(slug);
}
