const CleanWebpackPlugin = require('clean-webpack-plugin');
const ManifestPlugin = require('webpack-manifest-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');
const webpack = require('webpack');

const path = require('path');


const DIR = {
  APP: path.resolve(__dirname, './src/client'),
  BUILD: path.resolve(__dirname, './src/dist/assets'),
};

console.log(process.env.NODE_ENV);
const production = ((process.env.NODE_ENV || '').toLowerCase() === 'production');

module.exports = {
  entry: [
    '@babel/polyfill',
    'url-search-params-polyfill',
    path.join(DIR.APP, 'js', 'main.js'),
    path.join(DIR.APP, 'scss', 'main.scss'),
  ],
  output: {
    chunkFilename: '[chunkhash].js',
    filename: (production) ? '[chunkhash].js' : 'app.js',
    path: DIR.BUILD,
    publicPath: '/assets/',
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env'],
            plugins: ['@babel/plugin-syntax-dynamic-import'],
          },
        },
      },
      {
        test: /\.s?css$/,
        use: [
          MiniCssExtractPlugin.loader,
          'css-loader', 'sass-loader',
        ],
      },
      {
        test: /\.(png|jpe?g|gif|svg)$/,
        use: [
          {
            loader: 'file-loader',
            options: {
              name: '[hash].[ext]',
            },
          },
        ],
      },
      {
        test: /\.(ttf|eot|woff|woff2)$/,
        use: {
          loader: 'file-loader',
          options: {
            name: '[hash].[ext]',
          },
        },
      },
      {
        test: /favicon\.ico$/,
        use: {
          loader: 'file-loader',
          options: {
            name: '[name].[ext]',
          },
        },
      },
    ],
  },
  mode: (production) ? 'production' : 'development',
  plugins: [
    new CleanWebpackPlugin(['./*.*'], {root: DIR.BUILD}),
    new MiniCssExtractPlugin({filename: (production) ? '[hash].css' : 'app.css'}),
    new ManifestPlugin({
      filename: 'manifest.json',
      filter: (file) => file.isInitial,
      map: (file) => {
        file.name = file.name.split('.').pop();
        return file;
      },
      serialize: (manifest) => JSON.stringify(manifest),
    }),
    new MonacoWebpackPlugin(),
  ],
};
