import m from 'mithril';

import { Api } from '../../api';
import { Auth } from '../../auth';
import { TextMedia } from '../media';


export class Route {
  async oninit(vnode) {
    this.loading = true;
    this.error = null;
    this.count = 0;

    try {
      const response = await Api.fetchFiles();
      console.log(response);
      this.count = response.total;
    } catch(error) {
      console.error(error);
      this.error = error;
    }
    this.loading = false;
    m.redraw();
  }

  view(vnode) {
    if (this.loading) {
      return 'loading data...';
    }
    if (this.error) {
      return `error fetching ur data lol: ${this.error.message}`;
    }

    return m('div', [
      m('span', {class: 'count'}, `You have uploaded ${this.count.toLocaleString()} files.`),
      m('div', {class: 'config'}, [
        m('span', 'ShareX Config'),
        m('div', {style: 'width: 70vw; height: 500px;'}, [
          m(TextMedia, {
            useMonaco: true,
            settings: {
              automaticLayout: true,
              language: 'json',
              readOnly: true,
              theme: 'vs-dark',
              value: JSON.stringify({
                Name: 'files.gg',
                DestinationType: 'ImageUploader, TextUploader, FileUploader',
                RequestURL: 'https://api.files.gg/files',
                FileFormName: 'file',
                Arguments: {
                  vanity: '3-5/3',
                },
                Headers: {
                  authorization: Auth.token,
                },
              }, null, 2),
            },
          }),
        ]),
      ]),
    ]);
  }
}
Route.className = 'dashboard-configs';
