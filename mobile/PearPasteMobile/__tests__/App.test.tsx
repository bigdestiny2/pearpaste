/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../../app/App';

jest.mock(
  'expo-linear-gradient',
  () => {
    const React = require('react');
    const {View} = require('react-native');
    return {
      LinearGradient: ({children, ...props}: {children?: React.ReactNode}) =>
        React.createElement(View, props, children),
    };
  },
  {virtual: true},
);

jest.mock(
  'expo-camera',
  () => {
    const React = require('react');
    const {View} = require('react-native');
    return {
      CameraView: (props: object) => React.createElement(View, props),
      useCameraPermissions: () => [
        {granted: false},
        jest.fn(async () => ({granted: false})),
      ],
    };
  },
  {virtual: true},
);

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: {
    getString: jest.fn(async () => ''),
    setString: jest.fn(),
  },
}));

jest.mock('../../app/lib/MobilePearEnd', () => ({
  getMobilePearEnd: () => ({
    on: jest.fn(() => jest.fn()),
  }),
}));

jest.mock('../../app/lib/usePearPasteRpc', () => ({
  usePearPasteRpc: () => ({
    crash: null,
    crashed: false,
    pairRequest: null,
    relayCount: 0,
    retry: jest.fn(),
    rpc: {},
    status: 'starting',
  }),
}));

test('renders the shared mobile app shell', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
