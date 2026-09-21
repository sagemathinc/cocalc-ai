const React = require("react");
module.exports = {
  Platform: { OS: "ios" },
  PlatformColor: (name) => name,
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Alert: { alert: jest.fn() },
  ScrollView: "ScrollView",
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  TextInput: "TextInput",
  ActivityIndicator: "ActivityIndicator",
  RefreshControl: "RefreshControl",
  FlatList: ({ data, renderItem, ListEmptyComponent, ListHeaderComponent }) =>
    React.createElement(
      "FlatList",
      {},
      ListHeaderComponent,
      data.length
        ? data.map((item) =>
            React.createElement(
              React.Fragment,
              { key: item.endpoint?.agent_id ?? item.message_id },
              renderItem({ item }),
            ),
          )
        : ListEmptyComponent,
    ),
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove() {} }),
  },
  StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
  useColorScheme: () => "dark",
};
