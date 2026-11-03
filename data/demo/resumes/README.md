# Local resume PDFs

25 readable PDF files using the existing candidate keys: 13 original self-published resumes and 12 sourced demo reconstructions. No Muse calls were made.

Use `manifest.json` to join files to candidate profiles and distinguish original from reconstructed documents. LinkedIn and portfolio links are provenance only; the pipeline input is the local PDF. Original downloaded PDFs are unchanged. Reconstructed PDFs visibly identify themselves as demo documents and include source links.

Anas Zahou (Skeurz) and Ruben Edery have limited-source documents; work history and skills were not invented. HKUDS is Chao Huang’s lab organization, not a personal GitHub identity. The three extra profiles without resume sources remain without PDFs.

| Candidate | PDF | Document type | Pages |
| --- | --- | --- | --- |
| Sindre Sorhus | [sindresorhus.pdf](sindresorhus.pdf) | reconstructed demo resume | 1 |
| Andrej Karpathy | [karpathy.pdf](karpathy.pdf) | reconstructed demo resume | 2 |
| Donne Martin | [donnemartin.pdf](donnemartin.pdf) | reconstructed demo resume | 1 |
| Kamran Ahmed | [nilbuild.pdf](nilbuild.pdf) | reconstructed demo resume | 1 |
| Chao Huang | [HKUDS.pdf](HKUDS.pdf) | reconstructed demo resume | 1 |
| John Washam | [jwasham.pdf](jwasham.pdf) | reconstructed demo resume | 1 |
| Anas Zahou | [Skeurz.pdf](Skeurz.pdf) | reconstructed demo resume (limited source) | 1 |
| Ruben Edery | [rubenedery.pdf](rubenedery.pdf) | reconstructed demo resume (limited source) | 1 |
| Anthony Fu | [antfu.pdf](antfu.pdf) | original public resume | 2 |
| Lea Verou | [LeaVerou.pdf](LeaVerou.pdf) | reconstructed demo resume | 2 |
| Gaël Varoquaux | [GaelVaroquaux.pdf](GaelVaroquaux.pdf) | original public resume | 1 |
| Ismael Marin | [igmarin.pdf](igmarin.pdf) | original public resume | 2 |
| Sahil Aukhaj | [SahilAukhaj.pdf](SahilAukhaj.pdf) | original public resume | 1 |
| Andrew Pleeter | [anpl1623.pdf](anpl1623.pdf) | original public resume | 1 |
| Jhon Rocha | [jhonrocha.pdf](jhonrocha.pdf) | original public resume | 4 |
| Subhan Nadeem | [Subhan2117.pdf](Subhan2117.pdf) | reconstructed demo resume | 1 |
| Shubham Kadam | [H-R-Wells2.pdf](H-R-Wells2.pdf) | original public resume | 2 |
| Subeen Chang | [shuobyian.pdf](shuobyian.pdf) | reconstructed demo resume | 2 |
| Ishan Sachdeva | [Ishan-sa.pdf](Ishan-sa.pdf) | original public resume | 2 |
| Tadiwanashe Dzvoti | [TDD66.pdf](TDD66.pdf) | reconstructed demo resume | 1 |
| Viet Nguyen | [viet-in-tech.pdf](viet-in-tech.pdf) | original public resume | 2 |
| Ibraheem Obanla | [tolatechy.pdf](tolatechy.pdf) | original public resume | 2 |
| Derek Rodriguez | [dwrodri.pdf](dwrodri.pdf) | original public resume | 1 |
| Emir Afwan | [emirafwan.pdf](emirafwan.pdf) | original public resume | 2 |
| Akul Gopal Devali | [akuldevali.pdf](akuldevali.pdf) | original public resume | 2 |

Import uses local files only. Do not fetch resume URLs or add Word parsing for this batch. Keep PDF bytes and extracted resume text out of public API responses. Existing resume data-use rules apply.

PDFs are local demo inputs and excluded from git. Keep the manifest and this README as the mapping/provenance reference.

The demo fixtures are under `data/demo/`: candidate profiles in `public-developers/`, PDFs and provenance in `resumes/`, job data in `employers/`, and saved assessments and imported profile data in `seed/demo-seed.json`. The seed includes 3 candidate assessments and no job assessments. Assessments are preserved as saved, and changing a résumé can make its prior assessment stale; missing or stale assessments require a new analysis.
