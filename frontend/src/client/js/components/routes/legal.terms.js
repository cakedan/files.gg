import m from 'mithril';


export class Route {
  view(vnode) {
    return m('div', {class: 'content'}, [
      m('div', {class: 'header'}, [
        m('h2', 'Files.gg Terms of Service'),
      ]),
      m('div', {class: 'sections'}, [
        m('div', {class: 'section'}, [
          m('h3', '1. Terms'),
          m('p', 'By accessing the website at https://files.gg, you are agreeing to be bound by these terms of service, all applicable laws and regulations, and agree that you are responsible for compliance with any applicable local laws. If you do not agree with any of these terms, you are prohibited from using or accessing this site. The materials contained in this website are protected by applicable copyright and trademark law.'),
        ]),
        m('div', {class: 'section'}, [
          m('h3', '2. Use License'),
          m('ol', {type: 'a'}, [
            m('li', 'Permission is granted to temporarily download one copy of the materials (information or software) on Files.gg\'s website for personal, non-commercial transitory viewing only. This is the grant of a license, not a transfer of title, and under this license you may not:'),
            m('ol', {type: 'i'}, [
              m('li', 'modify or copy the materials;'),
              m('li', 'use the materials for any commercial purpose, or for any public display (commercial or non-commercial);'),
              m('li', 'attempt to decompile or reverse engineer any software contained on Files.gg\'s website;'),
              m('li', 'remove any copyright or other proprietary notations from the materials; or'),
              m('li', 'transfer the materials to another person or "mirror" the materials on any other server.'),
            ]),
            m('li', 'This license shall automatically terminate if you violate any of these restrictions and may be terminated by Files.gg at any time. Upon terminating your viewing of these materials or upon the termination of this license, you must destroy any downloaded materials in your possession whether in electronic or printed format.'),
          ]),
        ]),
        m('div', {class: 'section'}, [
          m('h3', '3. Disclaimer'),
          m('ol', {type: 'a'}, [
            m('li', 'The materials on Files.gg\'s website are provided on an \'as is\' basis. Files.gg makes no warranties, expressed or implied, and hereby disclaims and negates all other warranties including, without limitation, implied warranties or conditions of merchantability, fitness for a particular purpose, or non-infringement of intellectual property or other violation of rights.'),
            m('li', 'Further, Files.gg does not warrant or make any representations concerning the accuracy, likely results, or reliability of the use of the materials on its website or otherwise relating to such materials or on any sites linked to this site.'),
          ]),
        ]),
        m('div', {class: 'section'}, [
          m('h3', '4. Limitations'),
          m('li', 'In no event shall Files.gg or its suppliers be liable for any damages (including, without limitation, damages for loss of data or profit, or due to business interruption) arising out of the use or inability to use the materials on Files.gg\'s website, even if Files.gg or a Files.gg authorized representative has been notified orally or in writing of the possibility of such damage. Because some jurisdictions do not allow limitations on implied warranties, or limitations of liability for consequential or incidental damages, these limitations may not apply to you.'),
        ]),
        m('div', {class: 'section'}, [
          m('h3', '5. Accuracy of Materials'),
          m('li', 'The materials appearing on Files.gg\'s website could include technical, typographical, or photographic errors. Files.gg does not warrant that any of the materials on its website are accurate, complete or current. Files.gg may make changes to the materials contained on its website at any time without notice. However Files.gg does not make any commitment to update the materials.'),
        ]),
        m('div', {class: 'section'}, [
          m('h3', '6. Links'),
          m('li', 'Files.gg has not reviewed all of the sites linked to its website and is not responsible for the contents of any such linked site. The inclusion of any link does not imply endorsement by Files.gg of the site. Use of any such linked website is at the user\'s own risk.'),
        ]),
        m('div', {class: 'section'}, [
          m('h3', '7. Modifications'),
          m('li', 'Files.gg may revise these terms of service for its website at any time without notice. By using this website you are agreeing to be bound by the then current version of these terms of service.'),
        ]),
        m('div', {class: 'section'}, [
          m('h3', '8. Governing Law'),
          m('li', 'These terms and conditions are governed by and construed in accordance with the laws of Florida and you irrevocably submit to the exclusive jurisdiction of the courts in that State or location.'),
        ]),
      ]),
    ]);
  }
}
Route.className = 'legal-terms';
