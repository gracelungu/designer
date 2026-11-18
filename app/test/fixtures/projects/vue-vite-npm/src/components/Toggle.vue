<script>
export default {
  props: {
    on: { type: Boolean, default: false },
    label: { type: String, required: true },
  },
};
</script>
<template><button>{{ label }}</button></template>
