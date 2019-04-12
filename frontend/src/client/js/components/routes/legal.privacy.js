import m from 'mithril';


export class Route {
  view(vnode) {
    return m('div', {class: 'content'}, [
      m('div', {class: 'header'}, [
        m('h2', 'Privacy Policy'),
      ]),
      m('div', {class: 'sections'}, [
        m('div', {class: 'section'}, [
          m('p', 'Your privacy is important to us. It is Files.gg\'s policy to respect your privacy regarding any information we may collect from you across our website, https://files.gg, and other sites we own and operate.'),
          m('p', 'We only ask for personal information when we truly need it to provide a service to you. We collect it by fair and lawful means, with your knowledge and consent. We also let you know why we\'re collecting it and how it will be used.'),
          m('p', 'We only retain collected information for as long as necessary to provide you with your requested service. What data we store, we\'ll protect within commercially acceptable means to prevent loss and theft, as well as unauthorised access, disclosure, copying, use or modification.'),
          m('p', 'We don\'t share any personally identifying information publicly or with third-parties, except when required to by law.'),
          m('p', 'Our website may link to external sites that are not operated by us. Please be aware that we have no control over the content and practices of these sites, and cannot accept responsibility or liability for their respective privacy policies.'),
          m('p', 'You are free to refuse our request for your personal information, with the understanding that we may be unable to provide you with some of your desired services.'),
          m('p', 'Your continued use of our website will be regarded as acceptance of our practices around privacy and personal information. If you have any questions about how we handle user data and personal information, feel free to contact us.'),
        ]),
      ]),
      m('div', {class: 'footer'}, [
        m('p', 'This policy is effective as of 11 April 2019.'),
      ]),
    ]);
  }
}
Route.className = 'legal-privacy';
